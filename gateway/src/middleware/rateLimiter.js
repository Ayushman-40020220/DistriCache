const crypto = require('crypto');
const { redis } = require('../config/redis');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Distributed Atomic Rate Limiter Middleware
 * Executes sliding-window evaluation atomically inside Redis via Lua script.
 */
function createRateLimiter() {
  return async function rateLimiterMiddleware(req, res, next) {
    try {
      const route = req.matchedRoute;

      // Skip if route does not require rate limiting
      if (route && route.rate_limit_required === false) {
        return next();
      }

      // Determine client identity: API key client ID or Client IP
      const client = req.client;
      const clientIdentifier = client ? `client:${client.id}` : `ip:${req.ip || req.connection.remoteAddress}`;
      const routeIdentifier = route ? `route:${route.id}` : 'route:global';
      const redisKey = `ratelimit:${clientIdentifier}:${routeIdentifier}`;

      // Determine policy limits
      let maxRequests = config.defaultRateLimitMax;
      let windowSeconds = config.defaultRateLimitWindowSec;

      if (client) {
        // Priority 1: Direct key override
        if (client.rate_limit_override_max && client.rate_limit_override_window) {
          maxRequests = client.rate_limit_override_max;
          windowSeconds = client.rate_limit_override_window;
        } else if (client.policy) {
          // Priority 2: Assigned tier policy
          maxRequests = client.policy.max_requests;
          windowSeconds = client.policy.window_seconds;
        }
      }

      const windowMs = windowSeconds * 1000;
      const now = Date.now();
      const memberId = `${now}-${crypto.randomBytes(4).toString('hex')}`;

      // Execute atomic Lua script
      const [allowed, remaining, resetOrRetry] = await redis.slidingWindowRateLimit(
        redisKey,
        now,
        windowMs,
        maxRequests,
        memberId
      );

      // Attach standard rate-limiting headers
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining));
      res.setHeader('X-RateLimit-Reset', resetOrRetry);

      if (allowed === 1) {
        // Request allowed
        return next();
      }

      // Request Rate Limited (HTTP 429)
      res.setHeader('Retry-After', resetOrRetry);
      logger.warn(`Rate limit exceeded for [${clientIdentifier}] on [${req.originalUrl}]. Retry after ${resetOrRetry}s`);

      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit quota exceeded. Please retry after ${resetOrRetry} seconds.`,
        limit: maxRequests,
        remaining: 0,
        retryAfter: resetOrRetry
      });
    } catch (err) {
      logger.error('Rate limiter execution error', { error: err.message, stack: err.stack });
      // Fail-open strategy to prevent gateway outage on Redis glitches, or fail-closed based on policy
      // In production resilient gateways, fail-open with logging is standard practice
      return next();
    }
  };
}

module.exports = createRateLimiter;

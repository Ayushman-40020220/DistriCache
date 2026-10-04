const crypto = require('crypto');
const db = require('../config/db');
const { redis } = require('../config/redis');
const logger = require('../utils/logger');

const API_KEY_CACHE_TTL = 300; // 5 minutes cache in Redis

/**
 * Authentication Middleware with Redis Cache-Aside
 */
function createAuthMiddleware() {
  return async function authMiddleware(req, res, next) {
    try {
      const route = req.matchedRoute;

      // Allow bypass if route doesn't require authentication
      if (route && route.auth_required === false) {
        return next();
      }

      // Extract key from X-API-Key header or Authorization: Bearer <token>
      let rawKey = req.headers['x-api-key'];
      if (!rawKey && req.headers.authorization) {
        const parts = req.headers.authorization.split(' ');
        if (parts.length === 2 && (parts[0] === 'Bearer' || parts[0] === 'ApiKey')) {
          rawKey = parts[1];
        }
      }

      if (!rawKey) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing API key. Provide via X-API-Key header or Authorization: Bearer <key>.'
        });
      }

      // Hash key to prevent timing attacks and plaintext database queries
      const keyHash = crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
      const cacheKey = `auth:apikey:${keyHash}`;

      // 1. Try Redis cache-aside first (sub-millisecond)
      const cached = await redis.get(cacheKey);
      if (cached) {
        const client = JSON.parse(cached);
        req.client = client;
        return next();
      }

      // 2. Query PostgreSQL on cache miss
      const query = `
        SELECT 
          k.id,
          k.client_name,
          k.is_active,
          k.expires_at,
          k.rate_limit_override_max,
          k.rate_limit_override_window,
          k.metadata,
          p.id AS policy_id,
          p.name AS policy_name,
          p.max_requests AS policy_max_requests,
          p.window_seconds AS policy_window_seconds
        FROM api_keys k
        LEFT JOIN rate_limit_policies p ON k.policy_id = p.id
        WHERE k.key_hash = $1
      `;
      const result = await db.query(query, [keyHash]);

      if (result.rows.length === 0) {
        logger.warn(`Failed authentication attempt with invalid key hash: ${keyHash.substring(0, 8)}...`);
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid API key provided.'
        });
      }

      const row = result.rows[0];

      if (!row.is_active) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'API key is deactivated.'
        });
      }

      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'API key has expired.'
        });
      }

      const client = {
        id: row.id,
        name: row.client_name,
        metadata: row.metadata,
        rate_limit_override_max: row.rate_limit_override_max,
        rate_limit_override_window: row.rate_limit_override_window,
        policy: row.policy_id ? {
          id: row.policy_id,
          name: row.policy_name,
          max_requests: row.policy_max_requests,
          window_seconds: row.policy_window_seconds
        } : null
      };

      // Store in Redis cache
      await redis.setex(cacheKey, API_KEY_CACHE_TTL, JSON.stringify(client));

      req.client = client;
      return next();
    } catch (err) {
      logger.error('Authentication error', { error: err.message, stack: err.stack });
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Authentication service encountered an unexpected error.'
      });
    }
  };
}

module.exports = createAuthMiddleware;

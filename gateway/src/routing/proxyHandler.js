const httpProxy = require('http-proxy');
const { circuitBreakerRegistry, CircuitState } = require('../circuitBreaker/CircuitBreaker');
const logger = require('../utils/logger');

const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  xfwd: true,
  autoRewrite: false,
  proxyTimeout: 30000,
  timeout: 30000
});

// Capture proxy errors (connection refused, timeout, etc.)
proxy.on('error', (err, req, res) => {
  logger.error('Proxy network error', {
    requestId: req.id,
    target: req.proxyTargetUrl,
    error: err.message,
    code: err.code
  });

  const breaker = req.circuitBreaker;
  if (breaker) {
    breaker.recordResult(false, err.code || 'NETWORK_ERROR');
  }

  if (res.headersSent) {
    return;
  }

  res.locals.errorMessage = `Proxy error: ${err.message}`;

  const isTimeout = err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT';
  const statusCode = isTimeout ? 504 : 502;
  const errorTitle = isTimeout ? 'Gateway Timeout' : 'Bad Gateway';

  res.status(statusCode).json({
    error: errorTitle,
    message: `Downstream service could not be reached or timed out (${err.message}).`,
    requestId: req.id,
    target: req.proxyTargetUrl
  });
});

// Intercept proxy response to track circuit breaker health
proxy.on('proxyRes', (proxyRes, req, res) => {
  const breaker = req.circuitBreaker;
  if (breaker) {
    if (proxyRes.statusCode >= 500) {
      breaker.recordResult(false, proxyRes.statusCode);
    } else {
      breaker.recordResult(true, proxyRes.statusCode);
    }
  }
});

function handleProxyRequest(req, res, next) {
  const route = req.matchedRoute;
  if (!route) {
    return res.status(404).json({
      error: 'Not Found',
      message: `No registered route matches path: ${req.originalUrl}`,
      requestId: req.id
    });
  }

  let breaker = null;
  if (route.circuit_breaker_enabled) {
    breaker = circuitBreakerRegistry.getOrCreate(route);
    req.circuitBreaker = breaker;

    if (!breaker.canExecute()) {
      res.setHeader('X-Circuit-Breaker', CircuitState.OPEN);
      logger.warn(`Fast-failing request ${req.id} to ${route.path_prefix} (Circuit Breaker OPEN)`);
      return res.status(503).json({
        error: 'Service Unavailable',
        message: `Downstream service for '${route.path_prefix}' is degraded. Circuit breaker is OPEN.`,
        circuitState: CircuitState.OPEN,
        recoveryTimeoutMs: route.circuit_breaker_recovery_timeout_ms || 15000,
        requestId: req.id
      });
    }

    res.setHeader('X-Circuit-Breaker', breaker.state);
  }

  // Calculate target URL and path
  let targetUrl = route.target_url;
  req.proxyTargetUrl = targetUrl;

  // Handle prefix stripping if configured
  if (route.strip_prefix) {
    req.url = req.originalUrl.replace(route.path_prefix, '') || '/';
  }

  // Set timeout if defined
  const timeoutMs = route.timeout_ms || 30000;

  proxy.web(req, res, {
    target: targetUrl,
    timeout: timeoutMs,
    proxyTimeout: timeoutMs
  });
}

module.exports = {
  proxy,
  handleProxyRequest
};

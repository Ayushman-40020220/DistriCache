const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./config/db');
const { testRedisConnection, redis } = require('./config/redis');
const { createTelemetryMiddleware, batcher } = require('./middleware/telemetry');
const createAuthMiddleware = require('./middleware/auth');
const createRateLimiter = require('./middleware/rateLimiter');
const errorHandler = require('./middleware/errorHandler');
const routeRegistry = require('./routing/RouteRegistry');
const { handleProxyRequest } = require('./routing/proxyHandler');
const { circuitBreakerRegistry } = require('./circuitBreaker/CircuitBreaker');
const HealthChecker = require('./circuitBreaker/HealthChecker');

const app = express();
const healthChecker = new HealthChecker({ intervalMs: config.healthCheckIntervalMs });

// Basic security & parsing
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());

// Telemetry & metrics logging (captures all incoming traffic)
app.use(createTelemetryMiddleware());

// ----------------------------------------------------------------------------
// Internal / Admin / Diagnostics Endpoints
// ----------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    gatewayInstance: config.gatewayInstanceId,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/admin/routes', (req, res) => {
  res.json({
    gatewayInstance: config.gatewayInstanceId,
    routes: routeRegistry.getRoutes()
  });
});

app.post('/admin/routes/reload', async (req, res, next) => {
  try {
    const updatedRoutes = await routeRegistry.loadRoutes();
    healthChecker.updateRoutes(updatedRoutes);
    res.json({
      message: 'Routes reloaded successfully from database.',
      count: updatedRoutes.length,
      routes: updatedRoutes.map((r) => r.path_prefix)
    });
  } catch (err) {
    next(err);
  }
});

app.get('/admin/circuit-breakers', (req, res) => {
  res.json({
    gatewayInstance: config.gatewayInstanceId,
    circuitBreakers: circuitBreakerRegistry.getAllStatus()
  });
});

app.get('/admin/health-checks', (req, res) => {
  res.json({
    gatewayInstance: config.gatewayInstanceId,
    targets: healthChecker.getStatus()
  });
});

// ----------------------------------------------------------------------------
// Dynamic Routing & Reverse Proxy Pipeline
// ----------------------------------------------------------------------------
// 1. Route Matching Middleware
app.use((req, res, next) => {
  const matched = routeRegistry.matchRoute(req.path);
  if (matched) {
    req.matchedRoute = matched;
    return next();
  }
  return res.status(404).json({
    error: 'Not Found',
    message: `No route registered matching path: ${req.path}`,
    requestId: req.id
  });
});

// 2. Authentication Middleware
app.use(createAuthMiddleware());

// 3. Distributed Atomic Rate Limiter Middleware
app.use(createRateLimiter());

// 4. Reverse Proxy Dispatcher
app.use((req, res, next) => {
  handleProxyRequest(req, res, next);
});

// 5. Global Error Handler
app.use(errorHandler);

// ----------------------------------------------------------------------------
// Server Initialization & Graceful Shutdown
// ----------------------------------------------------------------------------
async function startServer() {
  try {
    logger.info('Initializing DistriCache Gateway...');
    
    // Test backing services
    await db.testConnection();
    await testRedisConnection();

    // Load routes into registry
    const routes = await routeRegistry.loadRoutes();
    healthChecker.updateRoutes(routes);
    healthChecker.start();

    const server = app.listen(config.port, () => {
      logger.info(`DistriCache Gateway listening on port ${config.port}`, {
        environment: config.nodeEnv,
        routesConfigured: routes.length
      });
    });

    // Graceful Shutdown
    const shutdown = async (signal) => {
      logger.info(`Received ${signal}. Shutting down DistriCache Gateway gracefully...`);
      server.close(async () => {
        healthChecker.stop();
        logger.info('Flushing remaining telemetry logs...');
        await batcher.stop();
        await db.pool.end();
        redis.disconnect();
        logger.info('Gateway shutdown complete. Exiting.');
        process.exit(0);
      });

      // Force terminate after 10s if hung
      setTimeout(() => {
        logger.error('Forceful shutdown after timeout.');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error('Fatal initialization error in Gateway', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;

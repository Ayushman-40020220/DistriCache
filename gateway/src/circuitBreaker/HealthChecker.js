const http = require('http');
const https = require('https');
const logger = require('../utils/logger');
const { circuitBreakerRegistry, CircuitState } = require('./CircuitBreaker');

class HealthChecker {
  constructor(options = {}) {
    this.intervalMs = options.intervalMs || 10000;
    this.timeoutMs = options.timeoutMs || 3000;
    this.timer = null;
    this.targets = new Map(); // targetUrl -> { route, lastStatus, lastCheck, consecutiveFailures }
  }

  registerRoute(route) {
    if (!route || !route.target_url) return;
    const healthUrl = `${route.target_url.replace(/\/$/, '')}${route.health_check_path || '/health'}`;
    this.targets.set(route.id, {
      routeId: route.id,
      pathPrefix: route.path_prefix,
      targetUrl: route.target_url,
      healthUrl,
      lastStatus: 'UNKNOWN',
      lastCheck: null,
      consecutiveFailures: 0,
      responseTimeMs: 0
    });
  }

  updateRoutes(routes) {
    const activeRouteIds = new Set(routes.map(r => r.id));
    // Remove stale targets
    for (const [id] of this.targets.entries()) {
      if (!activeRouteIds.has(id)) {
        this.targets.delete(id);
      }
    }
    // Add or update active targets
    for (const route of routes) {
      this.registerRoute(route);
    }
  }

  start() {
    if (this.timer) return;
    logger.info(`Starting background HealthChecker (polling every ${this.intervalMs}ms)`);
    // Run initial check immediately
    this.pollAll();
    this.timer = setInterval(() => this.pollAll(), this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('HealthChecker stopped');
    }
  }

  async pollAll() {
    for (const [routeId, target] of this.targets.entries()) {
      await this.checkTarget(routeId, target);
    }
  }

  checkTarget(routeId, target) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const parsedUrl = new URL(target.healthUrl);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const req = client.get(
        target.healthUrl,
        { timeout: this.timeoutMs },
        (res) => {
          const latency = Date.now() - startTime;
          target.lastCheck = new Date().toISOString();
          target.responseTimeMs = latency;

          if (res.statusCode >= 200 && res.statusCode < 300) {
            target.lastStatus = 'HEALTHY';
            target.consecutiveFailures = 0;
            // Drain body
            res.resume();
            resolve();
          } else {
            target.lastStatus = 'DEGRADED';
            target.consecutiveFailures++;
            logger.warn(`Health check degraded for ${target.pathPrefix} (${target.healthUrl}): HTTP ${res.statusCode}`);
            res.resume();
            resolve();
          }
        }
      );

      req.on('error', (err) => {
        target.lastStatus = 'DOWN';
        target.consecutiveFailures++;
        target.lastCheck = new Date().toISOString();
        target.responseTimeMs = Date.now() - startTime;
        logger.warn(`Health check failed for ${target.pathPrefix} (${target.healthUrl}): ${err.message}`);
        resolve();
      });

      req.on('timeout', () => {
        req.destroy();
        target.lastStatus = 'TIMEOUT';
        target.consecutiveFailures++;
        target.lastCheck = new Date().toISOString();
        target.responseTimeMs = this.timeoutMs;
        logger.warn(`Health check timeout for ${target.pathPrefix} (${target.healthUrl})`);
        resolve();
      });
    });
  }

  getStatus() {
    const list = [];
    for (const [id, target] of this.targets.entries()) {
      list.push({ ...target });
    }
    return list;
  }
}

module.exports = HealthChecker;

const db = require('../config/db');
const logger = require('../utils/logger');

class RouteRegistry {
  constructor() {
    this.routes = [];
    this.routesById = new Map();
  }

  async loadRoutes() {
    try {
      const res = await db.query(
        `SELECT 
          id, path_prefix, target_url, strip_prefix,
          auth_required, rate_limit_required, semantic_cache_enabled,
          circuit_breaker_enabled, circuit_breaker_failure_threshold,
          circuit_breaker_recovery_timeout_ms, timeout_ms,
          health_check_path, health_check_interval_seconds, is_active
         FROM routes
         WHERE is_active = TRUE
         ORDER BY LENGTH(path_prefix) DESC`
      );

      this.routes = res.rows;
      this.routesById.clear();
      for (const r of this.routes) {
        this.routesById.set(r.id, r);
      }

      logger.info(`Loaded ${this.routes.length} active routes from database`, {
        prefixes: this.routes.map(r => r.path_prefix)
      });
      return this.routes;
    } catch (err) {
      logger.error('Failed to load routes from database', { error: err.message });
      throw err;
    }
  }

  matchRoute(requestPath) {
    // Longest prefix match
    for (const route of this.routes) {
      if (requestPath.startsWith(route.path_prefix)) {
        return route;
      }
    }
    return null;
  }

  getRoutes() {
    return [...this.routes];
  }

  getRouteById(id) {
    return this.routesById.get(id);
  }
}

const routeRegistry = new RouteRegistry();
module.exports = routeRegistry;

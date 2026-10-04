const EventEmitter = require('events');
const logger = require('../utils/logger');
const db = require('../config/db');

/**
 * Circuit Breaker States
 */
const CircuitState = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

class CircuitBreaker extends EventEmitter {
  constructor({
    routeId,
    routeName,
    errorThresholdRatio = 0.50,       // 50% failure rate over window
    minRequestsInWindow = 4,          // Minimum requests before evaluating ratio
    recoveryTimeoutMs = 15000,        // 15 seconds cool-down in OPEN state
    rollingWindowMs = 10000           // 10 seconds rolling window
  }) {
    super();
    this.routeId = routeId;
    this.routeName = routeName || routeId;
    this.errorThresholdRatio = errorThresholdRatio;
    this.minRequestsInWindow = minRequestsInWindow;
    this.recoveryTimeoutMs = recoveryTimeoutMs;
    this.rollingWindowMs = rollingWindowMs;

    this.state = CircuitState.CLOSED;
    this.samples = []; // Array of { timestamp: number, isSuccess: boolean, code: string|number }
    this.nextAttempt = Date.now();
    this.canaryProbeActive = false;
  }

  /**
   * Determine if request can proceed or must fast-fail with HTTP 503
   */
  canExecute() {
    const now = Date.now();

    if (this.state === CircuitState.CLOSED) {
      return true;
    }

    if (this.state === CircuitState.OPEN) {
      if (now >= this.nextAttempt) {
        // Cooldown period elapsed. Transition to HALF_OPEN and allow 1 canary probe
        this.transitionTo(
          CircuitState.HALF_OPEN,
          `Cooldown of ${this.recoveryTimeoutMs}ms elapsed. Dispatching canary probe.`
        );
        this.canaryProbeActive = true;
        return true;
      }
      return false; // Fast-fail
    }

    if (this.state === CircuitState.HALF_OPEN) {
      // In HALF_OPEN, allow single canary probe until result resolves
      if (!this.canaryProbeActive) {
        this.canaryProbeActive = true;
        return true;
      }
      return false; // Reject concurrent calls while canary probe is in-flight
    }

    return false;
  }

  /**
   * Record outcome of downstream request
   * @param {boolean} isSuccess - true for 2xx/3xx/4xx, false for 5xx or network errors/timeouts
   * @param {string|number} code - status code or error code
   */
  recordResult(isSuccess, code) {
    const now = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      this.canaryProbeActive = false;
      if (isSuccess) {
        this.transitionTo(CircuitState.CLOSED, `Canary probe succeeded (${code}). Circuit reset to CLOSED.`);
        this.samples = [];
      } else {
        this.nextAttempt = now + this.recoveryTimeoutMs;
        this.transitionTo(
          CircuitState.OPEN,
          `Canary probe failed (${code}). Tripping back to OPEN for ${this.recoveryTimeoutMs}ms.`
        );
      }
      return;
    }

    if (this.state === CircuitState.CLOSED) {
      this.samples.push({ timestamp: now, isSuccess, code });
      this.cleanupOldSamples();

      const total = this.samples.length;
      if (total >= this.minRequestsInWindow) {
        const failures = this.samples.filter((s) => !s.isSuccess).length;
        const failureRate = failures / total;

        if (failureRate >= this.errorThresholdRatio) {
          this.nextAttempt = now + this.recoveryTimeoutMs;
          this.transitionTo(
            CircuitState.OPEN,
            `Error rate ${(failureRate * 100).toFixed(1)}% exceeded threshold ${(this.errorThresholdRatio * 100)}% ` +
            `(${failures}/${total} failed in rolling ${this.rollingWindowMs}ms window).`
          );
        }
      }
    }
  }

  /**
   * Purge samples older than the rolling window
   */
  cleanupOldSamples() {
    const cutoff = Date.now() - this.rollingWindowMs;
    this.samples = this.samples.filter((s) => s.timestamp >= cutoff);
  }

  /**
   * Force transition state with event emission and DB logging
   */
  transitionTo(newState, reason) {
    const oldState = this.state;
    if (oldState === newState) return;

    this.state = newState;
    logger.warn(`[CircuitBreaker] [${this.routeName}] State changed: ${oldState} -> ${newState}. Reason: ${reason}`);

    this.emit('stateChange', {
      routeId: this.routeId,
      routeName: this.routeName,
      oldState,
      newState,
      reason,
      timestamp: new Date()
    });

    // Asynchronously persist event to PostgreSQL
    if (this.routeId) {
      db.query(
        `INSERT INTO circuit_breaker_events (route_id, previous_state, new_state, reason, consecutive_failures)
         VALUES ($1, $2, $3, $4, $5)`,
        [this.routeId, oldState, newState, reason, this.samples.filter(s => !s.isSuccess).length]
      ).catch((err) => {
        logger.error(`Failed to log circuit breaker event to DB: ${err.message}`);
      });
    }
  }

  getStatus() {
    this.cleanupOldSamples();
    const total = this.samples.length;
    const failures = this.samples.filter((s) => !s.isSuccess).length;
    const failureRate = total > 0 ? failures / total : 0;

    return {
      routeId: this.routeId,
      routeName: this.routeName,
      state: this.state,
      samplesInWindow: total,
      failuresInWindow: failures,
      failureRate: Math.round(failureRate * 1000) / 1000,
      thresholdRatio: this.errorThresholdRatio,
      nextAttempt: this.state === CircuitState.OPEN ? new Date(this.nextAttempt).toISOString() : null,
      recoveryTimeoutMs: this.recoveryTimeoutMs,
      rollingWindowMs: this.rollingWindowMs
    };
  }
}

/**
 * Registry managing circuit breakers for each route
 */
class CircuitBreakerRegistry {
  constructor() {
    this.breakers = new Map();
  }

  getOrCreate(route) {
    if (!this.breakers.has(route.id)) {
      const breaker = new CircuitBreaker({
        routeId: route.id,
        routeName: route.path_prefix,
        errorThresholdRatio: 0.50, // 50% over rolling window
        minRequestsInWindow: 4,    // Evaluate once at least 4 requests are in window
        recoveryTimeoutMs: route.circuit_breaker_recovery_timeout_ms || 15000,
        rollingWindowMs: 10000     // 10s rolling window
      });
      this.breakers.set(route.id, breaker);
    }
    return this.breakers.get(route.id);
  }

  getAllStatus() {
    const result = [];
    for (const breaker of this.breakers.values()) {
      result.push(breaker.getStatus());
    }
    return result;
  }
}

const circuitBreakerRegistry = new CircuitBreakerRegistry();

module.exports = {
  CircuitState,
  CircuitBreaker,
  circuitBreakerRegistry
};

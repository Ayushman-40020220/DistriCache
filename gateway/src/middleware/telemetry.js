const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');
const config = require('../config');
const logger = require('../utils/logger');

class TelemetryBatcher {
  constructor(flushIntervalMs = 1000, batchSize = 100) {
    this.buffer = [];
    this.flushIntervalMs = flushIntervalMs;
    this.batchSize = batchSize;
    this.timer = null;
    this.isFlushing = false;
  }

  start() {
    if (!this.timer) {
      this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.flush();
  }

  enqueue(logEntry) {
    this.buffer.push(logEntry);
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  async flush() {
    if (this.isFlushing || this.buffer.length === 0) return;
    this.isFlushing = true;

    const entriesToInsert = this.buffer.splice(0, this.batchSize);
    try {
      // Build dynamic multi-row INSERT for Postgres
      const valuePlaceholders = [];
      const values = [];
      let paramIdx = 1;

      for (const entry of entriesToInsert) {
        valuePlaceholders.push(
          `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`
        );
        values.push(
          entry.requestId,
          entry.apiKeyId || null,
          entry.routeId || null,
          entry.clientIp,
          entry.method,
          entry.path,
          entry.statusCode,
          entry.latencyMs,
          entry.cacheStatus || 'NONE',
          entry.cacheSimilarity !== undefined && entry.cacheSimilarity !== null ? entry.cacheSimilarity : null,
          entry.bytesSent || 0,
          entry.userAgent || '',
          entry.errorMessage || null
        );
      }

      const sql = `
        INSERT INTO audit_logs (
          request_id, api_key_id, route_id, client_ip, http_method, request_path,
          status_code, latency_ms, cache_status, cache_similarity, bytes_sent,
          user_agent, error_message
        ) VALUES ${valuePlaceholders.join(', ')}
      `;

      await db.query(sql, values);
    } catch (err) {
      logger.error('Failed to flush telemetry batch to PostgreSQL', {
        error: err.message,
        lostCount: entriesToInsert.length
      });
    } finally {
      this.isFlushing = false;
      // If there are remaining entries queued during flush, trigger another flush
      if (this.buffer.length >= this.batchSize) {
        setImmediate(() => this.flush());
      }
    }
  }
}

const batcher = new TelemetryBatcher(config.telemetryFlushIntervalMs, config.telemetryBatchSize);
batcher.start();

/**
 * Telemetry Middleware
 */
function createTelemetryMiddleware() {
  return function telemetryMiddleware(req, res, next) {
    const startTime = process.hrtime.bigint();
    const requestId = req.headers['x-request-id'] || uuidv4();
    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Gateway-Instance', config.gatewayInstanceId);

    // Capture response completion
    res.on('finish', () => {
      const endTime = process.hrtime.bigint();
      const latencyMs = Number(endTime - startTime) / 1e6; // Convert nanoseconds to milliseconds

      const cacheHeader = res.getHeader('x-cache') || 'NONE';
      const simHeader = res.getHeader('x-cache-similarity');
      const cacheSimilarity = simHeader ? parseFloat(simHeader) : null;

      const logEntry = {
        requestId,
        apiKeyId: req.client ? req.client.id : null,
        routeId: req.matchedRoute ? req.matchedRoute.id : null,
        clientIp: req.ip || req.connection.remoteAddress || '127.0.0.1',
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        latencyMs: Math.round(latencyMs * 1000) / 1000,
        cacheStatus: cacheHeader.toString().toUpperCase(),
        cacheSimilarity: isNaN(cacheSimilarity) ? null : cacheSimilarity,
        bytesSent: parseInt(res.getHeader('content-length') || '0', 10),
        userAgent: req.headers['user-agent'] || '',
        errorMessage: res.locals.errorMessage || null
      };

      batcher.enqueue(logEntry);
    });

    next();
  };
}

module.exports = {
  createTelemetryMiddleware,
  batcher
};

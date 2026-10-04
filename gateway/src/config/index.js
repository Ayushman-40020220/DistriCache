require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '8080', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  gatewayInstanceId: process.env.GATEWAY_INSTANCE_ID || `gw-${Math.random().toString(36).substring(2, 9)}`,

  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/districache',
  dbPoolMin: parseInt(process.env.DB_POOL_MIN || '2', 10),
  dbPoolMax: parseInt(process.env.DB_POOL_MAX || '20', 10),

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // Rate Limiting Defaults
  defaultRateLimitMax: parseInt(process.env.DEFAULT_RATELIMIT_MAX || '60', 10),
  defaultRateLimitWindowSec: parseInt(process.env.DEFAULT_RATELIMIT_WINDOW_SEC || '60', 10),

  // Circuit Breaker Defaults
  cbFailureThreshold: parseInt(process.env.CB_FAILURE_THRESHOLD || '5', 10),
  cbRecoveryTimeoutMs: parseInt(process.env.CB_RECOVERY_TIMEOUT_MS || '15000', 10),
  cbRollingWindowMs: parseInt(process.env.CB_ROLLING_WINDOW_MS || '10000', 10),

  // Health Check Poller
  healthCheckIntervalMs: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '10000', 10),

  // Telemetry
  telemetryFlushIntervalMs: parseInt(process.env.TELEMETRY_FLUSH_INTERVAL_MS || '1000', 10),
  telemetryBatchSize: parseInt(process.env.TELEMETRY_BATCH_SIZE || '100', 10)
};

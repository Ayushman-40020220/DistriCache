const Redis = require('ioredis');
const config = require('./index');
const logger = require('../utils/logger');

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 3000);
    logger.warn(`Redis disconnected. Reconnecting in ${delay}ms... (attempt ${times})`);
    return delay;
  }
});

redis.on('connect', () => {
  logger.info('Redis client connected to server');
});

redis.on('ready', () => {
  logger.info('Redis client ready to execute commands');
});

redis.on('error', (err) => {
  logger.error('Redis connection error', { error: err.message });
});

// ============================================================================
// Lua Script: Atomic Sliding Window Rate Limiter
// KEYS[1] = Rate limit key (e.g. ratelimit:client_id:route_id)
// ARGV[1] = Current timestamp in milliseconds (now)
// ARGV[2] = Sliding window size in milliseconds (window_ms)
// ARGV[3] = Max allowed requests in the window (max_requests)
// ARGV[4] = Unique member token (e.g. now-uuid)
//
// Returns an array:
//   [1] Allowed: 1 if request is permitted, 0 if rate limited
//   [2] Remaining: Number of requests remaining in current window
//   [3] Reset/Retry: If allowed, seconds until window clears; if blocked, seconds until retry
// ============================================================================
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local member_id = ARGV[4]

local clear_before = now - window_ms

-- 1. Remove timestamps that fall outside the active sliding window
redis.call('ZREMRANGEBYSCORE', key, '-inf', clear_before)

-- 2. Count requests currently inside the sliding window
local current_count = redis.call('ZCARD', key)

if current_count < max_requests then
    -- Request is permitted: record timestamp and member ID
    redis.call('ZADD', key, now, member_id)
    -- Extend key TTL to match window size to prevent orphaned memory
    redis.call('PEXPIRE', key, window_ms)
    
    local remaining = max_requests - current_count - 1
    local reset_seconds = math.ceil(window_ms / 1000)
    return { 1, remaining, reset_seconds }
else
    -- Request is rate limited: find the oldest timestamp to compute accurate Retry-After
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local retry_after = 1
    if oldest and #oldest >= 2 then
        local oldest_ts = tonumber(oldest[2])
        local wait_ms = (oldest_ts + window_ms) - now
        if wait_ms > 0 then
            retry_after = math.ceil(wait_ms / 1000)
        end
    end
    return { 0, 0, retry_after }
end
`;

// Register custom Lua command: redis.slidingWindowRateLimit(key, now, windowMs, maxRequests, memberId)
redis.defineCommand('slidingWindowRateLimit', {
  numberOfKeys: 1,
  lua: SLIDING_WINDOW_LUA
});

async function testRedisConnection(retries = 5, delayMs = 1500) {
  for (let i = 1; i <= retries; i++) {
    try {
      const pong = await redis.ping();
      logger.info('Redis ping successful', { response: pong });
      return true;
    } catch (err) {
      logger.warn(`Redis connection attempt ${i}/${retries} failed: ${err.message}`);
      if (i === retries) {
        throw new Error(`Failed to connect to Redis after ${retries} attempts: ${err.message}`);
      }
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
}

module.exports = {
  redis,
  testRedisConnection
};

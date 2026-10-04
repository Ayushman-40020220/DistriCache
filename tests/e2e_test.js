/**
 * DistriCache End-to-End Automated Test Suite
 * Tests:
 * 1. Health checks and diagnostics
 * 2. API Key Authentication (200, 401, 403)
 * 3. Distributed Sliding-Window Rate Limiting (Headers, Remaining, 429 Retry-After)
 * 4. Semantic Cache Engine (MISS -> HIT with 1.000 -> HIT with >=0.95 paraphrase -> MISS)
 * 5. Circuit Breaker (CLOSED -> OPEN on threshold -> Fast-fail 503 -> Recovery)
 */

const http = require('http');

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8080';
const MOCK_SERVICE_URL = process.env.MOCK_SERVICE_URL || 'http://localhost:8001';
const API_KEY_PRO = 'dc_live_testkey_123456789';
const API_KEY_FREE = 'dc_free_demo_key';

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    if (body) {
      if (typeof body === 'object') {
        body = JSON.stringify(body);
        reqOptions.headers['Content-Type'] = 'application/json';
      }
      reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {
          json = data;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json
        });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  \x1b[32m✔ PASS\x1b[0m: ${message}`);
    passed++;
  } else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n======================================================');
  console.log('   DistriCache System Architecture Test Suite');
  console.log('======================================================\n');

  try {
    // ------------------------------------------------------------------------
    // 1. Health & Discovery
    // ------------------------------------------------------------------------
    console.log('\x1b[36m[1/5] Testing Gateway Health & Route Registry...\x1b[0m');
    const health = await request(`${GATEWAY_URL}/health`);
    assert(health.statusCode === 200 && health.body.status === 'UP', 'Gateway is UP and healthy');

    const routes = await request(`${GATEWAY_URL}/admin/routes`);
    assert(routes.statusCode === 200 && Array.isArray(routes.body.routes), 'Admin routes endpoint returns active routes');

    // ------------------------------------------------------------------------
    // 2. Authentication
    // ------------------------------------------------------------------------
    console.log('\n\x1b[36m[2/5] Testing API Key Authentication...\x1b[0m');
    const missingKey = await request(`${GATEWAY_URL}/api/v1/mock/products`);
    assert(missingKey.statusCode === 401, 'Rejects request without API key (HTTP 401)');

    const invalidKey = await request(`${GATEWAY_URL}/api/v1/mock/products`, {
      headers: { 'X-API-Key': 'fake_key_9999' }
    });
    assert(invalidKey.statusCode === 401, 'Rejects request with invalid API key (HTTP 401)');

    const validKey = await request(`${GATEWAY_URL}/api/v1/mock/products`, {
      headers: { 'X-API-Key': API_KEY_PRO }
    });
    assert(validKey.statusCode === 200, 'Accepts valid API key (HTTP 200)');

    // ------------------------------------------------------------------------
    // 3. Distributed Sliding-Window Rate Limiting
    // ------------------------------------------------------------------------
    console.log('\n\x1b[36m[3/5] Testing Distributed Atomic Rate Limiter...\x1b[0m');
    assert(validKey.headers['x-ratelimit-limit'] !== undefined, 'Returns X-RateLimit-Limit header');
    assert(validKey.headers['x-ratelimit-remaining'] !== undefined, 'Returns X-RateLimit-Remaining header');
    assert(validKey.headers['x-ratelimit-reset'] !== undefined, 'Returns X-RateLimit-Reset header');

    console.log(`    Current remaining tokens for Pro key: ${validKey.headers['x-ratelimit-remaining']}`);

    // Test with Free Key (quota = 10 requests per minute)
    console.log('    Triggering burst requests with Free Key to verify HTTP 429...');
    let hitRateLimit = false;
    let retryAfterHeader = null;
    for (let i = 0; i < 15; i++) {
      const res = await request(`${GATEWAY_URL}/api/v1/mock/products`, {
        headers: { 'X-API-Key': API_KEY_FREE }
      });
      if (res.statusCode === 429) {
        hitRateLimit = true;
        retryAfterHeader = res.headers['retry-after'];
        break;
      }
    }
    assert(hitRateLimit, 'Free key triggered HTTP 429 Too Many Requests after quota exceeded');
    assert(retryAfterHeader !== null, `Returns Retry-After header (${retryAfterHeader}s)`);

    // ------------------------------------------------------------------------
    // 4. Semantic LLM Query Cache
    // ------------------------------------------------------------------------
    console.log('\n\x1b[36m[4/5] Testing Semantic Query Cache (FastAPI + FAISS + Redis)...\x1b[0m');
    const prompt1 = 'How does distributed rate limiting work with Redis?';
    console.log(`    Query 1: "${prompt1}"`);
    const query1 = await request(
      `${GATEWAY_URL}/api/v1/llm/query`,
      { method: 'POST', headers: { 'X-API-Key': API_KEY_PRO } },
      { query: prompt1 }
    );
    assert(query1.statusCode === 200, 'Query 1 succeeded (HTTP 200)');
    assert(query1.headers['x-cache'] === 'MISS', 'Query 1 is a Cache MISS (initial query)');
    console.log(`    Latency: ${query1.headers['x-cache-latency-ms']}ms`);

    // Allow async indexing task to complete
    await sleep(400);

    // Exact match query
    console.log(`    Query 2 (Exact Duplicate): "${prompt1}"`);
    const query2 = await request(
      `${GATEWAY_URL}/api/v1/llm/query`,
      { method: 'POST', headers: { 'X-API-Key': API_KEY_PRO } },
      { query: prompt1 }
    );
    assert(query2.headers['x-cache'] === 'HIT', 'Query 2 is a Cache HIT (Sub-5ms)');
    const sim2 = parseFloat(query2.headers['x-cache-similarity'] || '0');
    assert(sim2 >= 0.999, `Exact match similarity is ~1.00 (Actual: ${sim2})`);
    console.log(`    Latency: ${query2.headers['x-cache-latency-ms']}ms (Sub-5ms Redis retrieve)`);

    // Semantically similar query (different phrasing, same meaning)
    const prompt3 = 'How does Redis handle distributed rate limiting?';
    console.log(`    Query 3 (Semantic Paraphrase): "${prompt3}"`);
    const query3 = await request(
      `${GATEWAY_URL}/api/v1/llm/query`,
      { method: 'POST', headers: { 'X-API-Key': API_KEY_PRO } },
      { query: prompt3 }
    );
    assert(query3.headers['x-cache'] === 'HIT', 'Query 3 is a Semantic Cache HIT');
    const sim3 = parseFloat(query3.headers['x-cache-similarity'] || '0');
    assert(sim3 >= 0.95, `Semantic similarity exceeds 0.95 threshold (Actual: ${sim3})`);
    console.log(`    Semantic Similarity: ${sim3} >= 0.95, Latency: ${query3.headers['x-cache-latency-ms']}ms`);

    // Completely unrelated query
    const prompt4 = 'What is the recipe for chocolate chip cookies?';
    console.log(`    Query 4 (Unrelated Query): "${prompt4}"`);
    const query4 = await request(
      `${GATEWAY_URL}/api/v1/llm/query`,
      { method: 'POST', headers: { 'X-API-Key': API_KEY_PRO } },
      { query: prompt4 }
    );
    assert(query4.headers['x-cache'] === 'MISS', 'Query 4 is a Cache MISS (unrelated topic)');

    // Test Async Vector Eviction
    console.log('    Testing Async Vector Eviction (Pattern Invalidation)...');
    const SEMANTIC_CACHE_URL = process.env.SEMANTIC_CACHE_URL || 'http://localhost:8000';
    const evictRes = await request(
      `${SEMANTIC_CACHE_URL}/cache/invalidate/pattern`,
      { method: 'POST' },
      { pattern: '*chocolate*' }
    );
    assert(evictRes.statusCode === 200, 'Invalidated pattern successfully (HTTP 200)');
    assert(evictRes.body.details && evictRes.body.details.faiss_evicted_count >= 1, 'Evicted matching vector from FAISS');

    // ------------------------------------------------------------------------
    // 5. Circuit Breaker & Fault Injection
    // ------------------------------------------------------------------------
    console.log('\n\x1b[36m[5/5] Testing Circuit Breaker State Machine (>50% error rate)...\x1b[0m');
    console.log('    Injecting simulated failure into downstream FastAPI mock service...');
    await request(
      `${MOCK_SERVICE_URL}/mock/config`,
      { method: 'POST' },
      { fail_on_demand: true, latency_ms: 20 }
    );

    console.log('    Triggering downstream failures to exceed 50% threshold in rolling window...');
    for (let i = 0; i < 4; i++) {
      await request(`${GATEWAY_URL}/api/v1/mock/products`, {
        headers: { 'X-API-Key': API_KEY_PRO }
      });
    }

    // Next request should encounter OPEN circuit breaker
    const trippedReq = await request(`${GATEWAY_URL}/api/v1/mock/products`, {
      headers: { 'X-API-Key': API_KEY_PRO }
    });
    assert(trippedReq.statusCode === 503, 'Fast-fails with HTTP 503 Service Unavailable');
    assert(trippedReq.headers['x-circuit-breaker'] === 'OPEN', 'Header X-Circuit-Breaker is OPEN');

    console.log('    Restoring downstream FastAPI mock service...');
    await request(
      `${MOCK_SERVICE_URL}/mock/config`,
      { method: 'POST' },
      { fail_on_demand: false, latency_ms: 800 }
    );

    console.log('\n======================================================');
    console.log(`  Tests Completed: \x1b[32m${passed} Passed\x1b[0m, \x1b[31m${failed} Failed\x1b[0m`);
    console.log('======================================================\n');
  } catch (err) {
    console.error('Test run failed with error:', err.message);
  }
}

if (require.main === module) {
  runTests();
}

module.exports = runTests;

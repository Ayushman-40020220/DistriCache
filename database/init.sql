-- ============================================================================
-- DistriCache & API Gateway - PostgreSQL Initialization Schema
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. Rate Limit Policies Table
-- Defines rate limit tiers (e.g. Free, Pro, Enterprise, Internal)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(64) UNIQUE NOT NULL,
    max_requests INTEGER NOT NULL CHECK (max_requests > 0),
    window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
    burst_capacity INTEGER DEFAULT 0 CHECK (burst_capacity >= 0),
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 2. API Keys Table
-- Manages client credentials, authentication, tier linkage, and quotas
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash VARCHAR(64) UNIQUE NOT NULL,           -- SHA-256 of the plain key
    client_name VARCHAR(128) NOT NULL,
    policy_id UUID REFERENCES rate_limit_policies(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at TIMESTAMP WITH TIME ZONE,
    rate_limit_override_max INTEGER CHECK (rate_limit_override_max > 0),
    rate_limit_override_window INTEGER CHECK (rate_limit_override_window > 0),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active) WHERE is_active = TRUE;

-- ----------------------------------------------------------------------------
-- 3. Downstream Services & Routes Table
-- Dynamic routing table configuration for reverse proxying
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    path_prefix VARCHAR(255) UNIQUE NOT NULL,       -- e.g. /api/v1/llm or /api/v1/products
    target_url VARCHAR(512) NOT NULL,              -- Downstream upstream URL
    strip_prefix BOOLEAN NOT NULL DEFAULT FALSE,
    auth_required BOOLEAN NOT NULL DEFAULT TRUE,
    rate_limit_required BOOLEAN NOT NULL DEFAULT TRUE,
    semantic_cache_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    circuit_breaker_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    circuit_breaker_failure_threshold INTEGER DEFAULT 5,
    circuit_breaker_recovery_timeout_ms INTEGER DEFAULT 15000,
    timeout_ms INTEGER DEFAULT 30000,
    health_check_path VARCHAR(255) DEFAULT '/health',
    health_check_interval_seconds INTEGER DEFAULT 10,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_routes_path_prefix ON routes(path_prefix);
CREATE INDEX IF NOT EXISTS idx_routes_active ON routes(is_active) WHERE is_active = TRUE;

-- ----------------------------------------------------------------------------
-- 4. Audit & Telemetry Logs Table
-- Append-only high-throughput log of incoming gateway traffic & metrics
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(64) NOT NULL,
    api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    route_id UUID REFERENCES routes(id) ON DELETE SET NULL,
    client_ip VARCHAR(45) NOT NULL,
    http_method VARCHAR(10) NOT NULL,
    request_path VARCHAR(1024) NOT NULL,
    status_code SMALLINT NOT NULL,
    latency_ms NUMERIC(10, 3) NOT NULL,
    cache_status VARCHAR(16) DEFAULT 'NONE',        -- 'HIT', 'MISS', 'BYPASS', 'NONE'
    cache_similarity NUMERIC(5, 4),                 -- e.g. 0.9821
    bytes_sent INTEGER DEFAULT 0,
    user_agent TEXT,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_request_id ON audit_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_status_code ON audit_logs(status_code);
CREATE INDEX IF NOT EXISTS idx_audit_logs_api_key_id ON audit_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_cache_status ON audit_logs(cache_status);

-- ----------------------------------------------------------------------------
-- 5. Circuit Breaker Event Logs Table
-- Records state transitions (CLOSED -> OPEN -> HALF_OPEN -> CLOSED)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS circuit_breaker_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    route_id UUID REFERENCES routes(id) ON DELETE CASCADE,
    previous_state VARCHAR(16) NOT NULL,
    new_state VARCHAR(16) NOT NULL,
    reason TEXT NOT NULL,
    consecutive_failures INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cb_events_route_id ON circuit_breaker_events(route_id, created_at DESC);

-- ============================================================================
-- SEED DATA
-- Default policies, test API keys, and registered routing endpoints
-- ============================================================================

-- 1. Insert Rate Limit Policies
INSERT INTO rate_limit_policies (id, name, max_requests, window_seconds, burst_capacity, description)
VALUES 
    ('11111111-1111-1111-1111-111111111111', 'FREE_TIER', 10, 60, 2, 'Default free tier: 10 req/min'),
    ('22222222-2222-2222-2222-222222222222', 'PRO_TIER', 100, 60, 20, 'Developer pro tier: 100 req/min'),
    ('33333333-3333-3333-3333-333333333333', 'ENTERPRISE_TIER', 1000, 60, 200, 'Enterprise tier: 1000 req/min')
ON CONFLICT (name) DO NOTHING;

-- 2. Insert Default Test API Keys
-- Plain key: 'dc_live_testkey_123456789'
-- SHA-256: encode(digest('dc_live_testkey_123456789', 'sha256'), 'hex')
--   = 3cb381014e27f06ca096ff809a96eef1e6b359fce8fcae5efaf9bc5ea9a642e7 (computed below)
-- Plain key: 'dc_enterprise_999999999'
-- Plain key: 'dc_free_demo_key'
INSERT INTO api_keys (id, key_hash, client_name, policy_id, is_active, metadata)
VALUES 
    (
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        encode(digest('dc_live_testkey_123456789', 'sha256'), 'hex'),
        'Test Suite Client (Pro Tier)',
        '22222222-2222-2222-2222-222222222222',
        TRUE,
        '{"tier": "pro", "environment": "staging"}'::jsonb
    ),
    (
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        encode(digest('dc_enterprise_999999999', 'sha256'), 'hex'),
        'Enterprise Partner Corp',
        '33333333-3333-3333-3333-333333333333',
        TRUE,
        '{"tier": "enterprise", "environment": "production"}'::jsonb
    ),
    (
        'cccccccc-cccc-cccc-cccc-cccccccccccc',
        encode(digest('dc_free_demo_key', 'sha256'), 'hex'),
        'Demo Free Client',
        '11111111-1111-1111-1111-111111111111',
        TRUE,
        '{"tier": "free", "environment": "demo"}'::jsonb
    )
ON CONFLICT (key_hash) DO NOTHING;

-- 3. Insert Default Downstream Gateway Routes
INSERT INTO routes (
    id, 
    path_prefix, 
    target_url, 
    strip_prefix, 
    auth_required, 
    rate_limit_required, 
    semantic_cache_enabled, 
    circuit_breaker_enabled, 
    circuit_breaker_failure_threshold,
    circuit_breaker_recovery_timeout_ms,
    health_check_path,
    is_active
)
VALUES 
    (
        '44444444-4444-4444-4444-444444444444',
        '/api/v1/llm',
        'http://semantic-cache:8000',
        FALSE,
        TRUE,
        TRUE,
        TRUE,
        TRUE,
        5,
        15000,
        '/health',
        TRUE
    ),
    (
        '55555555-5555-5555-5555-555555555555',
        '/api/v1/mock',
        'http://mock-service:8001',
        FALSE,
        TRUE,
        TRUE,
        FALSE,
        TRUE,
        3,
        10000,
        '/health',
        TRUE
    )
ON CONFLICT (path_prefix) DO NOTHING;

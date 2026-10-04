import React, { useState, useEffect, useRef } from 'react';

const GATEWAY_URL = window.location.origin;
const PRO_KEY = 'dc_live_testkey_123456789';
const FREE_KEY = 'dc_free_demo_key';

export default function App() {
  const [metrics, setMetrics] = useState({
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    hitRatioPct: 0,
    rateLimited: 0,
    avgHitLatencyMs: 4.1,
    avgMissLatencyMs: 820.0,
    avgOverallLatencyMs: 14.5,
    circuitBreakers: []
  });

  const [rateLimitData, setRateLimitData] = useState({
    activeLimiters: [],
    totalBreaches: 0
  });

  const [auditLogs, setAuditLogs] = useState([]);
  const [isPolling, setIsPolling] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState(new Date());

  // Interactive Workbench State
  const [promptInput, setPromptInput] = useState('How does distributed rate limiting work with Redis?');
  const [workbenchLoading, setWorkbenchLoading] = useState(false);
  const [workbenchResult, setWorkbenchResult] = useState(null);
  const [faultStatus, setFaultStatus] = useState(false);
  const [floodLoading, setFloodLoading] = useState(false);

  // Fetch telemetry and status from Gateway
  const fetchData = async () => {
    try {
      // 1. Metrics & Circuit Breakers
      const metricsRes = await fetch('/admin/metrics');
      if (metricsRes.ok) {
        const data = await metricsRes.json();
        setMetrics(data);
      }

      // 2. Rate Limiting Active State
      const rlRes = await fetch('/admin/rate-limits');
      if (rlRes.ok) {
        const rlData = await rlRes.json();
        setRateLimitData(rlData);
      }

      // 3. Audit Logs (Recent 20)
      const logsRes = await fetch('/admin/audit-logs?limit=20');
      if (logsRes.ok) {
        const logsData = await logsRes.json();
        setAuditLogs(logsData.logs || []);
      }

      setLastRefreshed(new Date());
    } catch (err) {
      console.error('Error fetching telemetry:', err);
    }
  };

  useEffect(() => {
    fetchData();
    let interval = null;
    if (isPolling) {
      interval = setInterval(fetchData, 2500);
    }
    return () => clearInterval(interval);
  }, [isPolling]);

  // Execute interactive query through Gateway
  const handleExecuteQuery = async (queryText) => {
    const q = queryText || promptInput;
    if (!q) return;

    setWorkbenchLoading(true);
    const start = performance.now();
    try {
      const res = await fetch('/api/v1/llm/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': PRO_KEY
        },
        body: JSON.stringify({ query: q })
      });

      const totalLatency = Math.round(performance.now() - start);
      const data = await res.json();

      setWorkbenchResult({
        statusCode: res.status,
        cacheStatus: res.headers.get('x-cache') || (data.cache_status || 'MISS'),
        similarity: res.headers.get('x-cache-similarity') || (data.similarity_score ? data.similarity_score.toFixed(4) : 'N/A'),
        serverLatencyMs: res.headers.get('x-cache-latency-ms') || data.latency_ms || totalLatency,
        totalClientLatencyMs: totalLatency,
        responseSnippet: data.response_payload ? (typeof data.response_payload === 'string' ? data.response_payload : JSON.stringify(data.response_payload).substring(0, 160) + '...') : JSON.stringify(data).substring(0, 160) + '...'
      });

      // Refresh table immediately after query
      setTimeout(fetchData, 500);
    } catch (err) {
      setWorkbenchResult({
        statusCode: 500,
        error: err.message
      });
    } finally {
      setWorkbenchLoading(false);
    }
  };

  // Trigger rapid rate-limit flood test (15 requests)
  const handleTriggerRateLimitFlood = async () => {
    setFloodLoading(true);
    try {
      const requests = Array.from({ length: 15 }).map(() =>
        fetch('/api/v1/mock/products', {
          headers: { 'X-API-Key': FREE_KEY }
        })
      );
      await Promise.all(requests);
      await fetchData();
    } catch (err) {
      console.error(err);
    } finally {
      setFloodLoading(false);
    }
  };

  // Toggle downstream mock failure injection
  const handleToggleFault = async () => {
    const nextFault = !faultStatus;
    try {
      await fetch('/mock/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fail_on_demand: nextFault, latency_ms: nextFault ? 50 : 800 })
      });
      setFaultStatus(nextFault);

      // If enabled, trigger a request to immediately show the breaker trip
      if (nextFault) {
        for (let i = 0; i < 5; i++) {
          await fetch('/api/v1/mock/products', { headers: { 'X-API-Key': PRO_KEY } });
        }
      }
      await fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  const latencySavings = metrics.avgMissLatencyMs > 0 && metrics.avgHitLatencyMs > 0
    ? Math.round(((metrics.avgMissLatencyMs - metrics.avgHitLatencyMs) / metrics.avgMissLatencyMs) * 100)
    : 99;

  return (
    <div className="app-container">
      {/* Top Header */}
      <header className="header">
        <div className="brand-wrapper">
          <div className="brand-logo">⚡</div>
          <div>
            <h1 className="brand-title">DistriCache Observability</h1>
            <p className="brand-subtitle">
              High-Throughput Gateway, Redis Rate Limiter & FAISS Semantic LLM Cache
            </p>
          </div>
        </div>

        <div className="header-actions">
          <div className="live-badge">
            <span className="pulse-dot"></span>
            LIVE TELEMETRY
          </div>
          <button
            className={`btn ${isPolling ? 'btn-secondary' : 'btn-primary'}`}
            onClick={() => setIsPolling(!isPolling)}
          >
            {isPolling ? 'Pause Polling' : 'Resume Polling'}
          </button>
          <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
            Updated: {lastRefreshed.toLocaleTimeString()}
          </span>
        </div>
      </header>

      {/* Key Metrics Overview Cards */}
      <div className="metrics-grid">
        <div className="card metric-card">
          <span className="metric-label">Total Proxied Requests</span>
          <span className="metric-value">{metrics.totalRequests.toLocaleString()}</span>
          <span className="metric-sub">Across all gateway routes</span>
        </div>

        <div className="card metric-card">
          <span className="metric-label">Semantic Cache Hits</span>
          <span className="metric-value" style={{ color: 'var(--accent-cyan)' }}>
            {metrics.cacheHits.toLocaleString()}
          </span>
          <span className="metric-sub">
            Hit Ratio: <strong style={{ color: 'var(--accent-emerald)' }}>{metrics.hitRatioPct}%</strong>
          </span>
        </div>

        <div className="card metric-card">
          <span className="metric-label">Rate-Limited Requests (429)</span>
          <span className="metric-value" style={{ color: rateLimitData.totalBreaches > 0 ? 'var(--accent-amber)' : 'var(--text-main)' }}>
            {rateLimitData.totalBreaches.toLocaleString()}
          </span>
          <span className="metric-sub">Enforced atomically via Redis</span>
        </div>

        <div className="card metric-card">
          <span className="metric-label">Avg Hit Response Time</span>
          <span className="metric-value" style={{ color: 'var(--accent-emerald)' }}>
            {metrics.avgHitLatencyMs} ms
          </span>
          <span className="metric-sub">Sub-5ms Redis payload retrieval</span>
        </div>
      </div>

      {/* Two Column Section: Circuit Breakers & Semantic Cache Analytics */}
      <div className="dashboard-grid">
        {/* Circuit Breakers & Health */}
        <div className="card">
          <div className="card-title">
            <span>Circuit Breaker State Machine</span>
            <button
              className={`btn ${faultStatus ? 'btn-warning' : 'btn-danger'}`}
              style={{ fontSize: '11px', padding: '4px 10px' }}
              onClick={handleToggleFault}
            >
              {faultStatus ? 'Disable Downstream Fault' : 'Inject Downstream Outage'}
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {metrics.circuitBreakers && metrics.circuitBreakers.length > 0 ? (
              metrics.circuitBreakers.map((cb) => (
                <div
                  key={cb.routeId}
                  style={{
                    padding: '14px',
                    borderRadius: '10px',
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid var(--border-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{cb.routeName}</span>
                    <span className={`cb-badge cb-${cb.state.toLowerCase()}`}>
                      ● {cb.state}
                    </span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', fontSize: '12px', color: 'var(--text-dim)' }}>
                    <div>
                      Window Samples: <strong style={{ color: 'var(--text-main)' }}>{cb.samplesInWindow || 0}</strong>
                    </div>
                    <div>
                      Error Rate: <strong style={{ color: cb.failureRate >= 0.5 ? 'var(--accent-rose)' : 'var(--text-main)' }}>
                        {((cb.failureRate || 0) * 100).toFixed(1)}%
                      </strong>
                    </div>
                    <div>
                      Threshold: <strong style={{ color: 'var(--text-main)' }}>{((cb.thresholdRatio || 0.5) * 100)}%</strong>
                    </div>
                  </div>

                  {cb.state === 'OPEN' && (
                    <div style={{ fontSize: '11px', color: 'var(--accent-rose)', background: 'rgba(244, 63, 94, 0.1)', padding: '6px 10px', borderRadius: '6px' }}>
                      Fast-failing incoming requests with HTTP 503 fallback. Cooldown: {cb.recoveryTimeoutMs / 1000}s.
                    </div>
                  )}
                </div>
              ))
            ) : (
              <p style={{ color: 'var(--text-dim)', fontSize: '13px' }}>No circuit breakers active</p>
            )}
          </div>
        </div>

        {/* Semantic Cache Latency Reduction */}
        <div className="card">
          <div className="card-title">
            <span>Semantic Cache Latency Reduction</span>
            <span style={{ fontSize: '12px', color: 'var(--accent-emerald)', fontWeight: 600 }}>
              FAISS + Redis Engine
            </span>
          </div>

          <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            Comparing expensive downstream LLM inference time against sub-5ms semantic vector cache hits.
          </p>

          <div className="latency-bar-container">
            {/* Cache MISS Row */}
            <div className="latency-row">
              <div className="latency-header">
                <span style={{ color: 'var(--accent-amber)' }}>Cache MISS (Downstream LLM)</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{metrics.avgMissLatencyMs} ms</span>
              </div>
              <div className="bar-track">
                <div className="bar-fill bar-miss" style={{ width: '100%' }}></div>
              </div>
            </div>

            {/* Cache HIT Row */}
            <div className="latency-row">
              <div className="latency-header">
                <span style={{ color: 'var(--accent-cyan)' }}>Cache HIT (FAISS + Redis)</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{metrics.avgHitLatencyMs} ms</span>
              </div>
              <div className="bar-track">
                <div
                  className="bar-fill bar-hit"
                  style={{ width: `${Math.max(1.5, (metrics.avgHitLatencyMs / metrics.avgMissLatencyMs) * 100)}%` }}
                ></div>
              </div>
            </div>

            {/* Savings Banner */}
            <div className="savings-banner">
              <div>
                <div className="savings-text">⚡ {latencySavings}% Latency Reduction</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Bypasses ~800ms model execution for all queries with cosine similarity ≥ 0.95
                </div>
              </div>
              <span style={{ fontSize: '20px', fontWeight: 800, color: 'var(--accent-emerald)', fontFamily: 'var(--font-mono)' }}>
                {Math.round(metrics.avgMissLatencyMs / Math.max(metrics.avgHitLatencyMs, 1))}x Faster
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Interactive Testing Workbench */}
      <div className="card">
        <div className="card-title">
          <span>Interactive Query & Benchmark Workbench</span>
          <button
            className="btn btn-secondary"
            style={{ fontSize: '11px', padding: '4px 10px' }}
            onClick={handleTriggerRateLimitFlood}
            disabled={floodLoading}
          >
            {floodLoading ? 'Firing Burst...' : '⚡ Test Rate Limiter (Fire 15 Req)'}
          </button>
        </div>

        <div className="workbench-container">
          <div className="preset-pills">
            <span style={{ fontSize: '12px', color: 'var(--text-dim)', alignSelf: 'center' }}>Try Presets:</span>
            <button
              className="preset-pill"
              onClick={() => {
                setPromptInput('How does distributed rate limiting work with Redis?');
                handleExecuteQuery('How does distributed rate limiting work with Redis?');
              }}
            >
              1. Cold Query (Miss)
            </button>
            <button
              className="preset-pill"
              onClick={() => {
                setPromptInput('How does Redis handle distributed rate limiting?');
                handleExecuteQuery('How does Redis handle distributed rate limiting?');
              }}
            >
              2. Paraphrase (Hit ≥ 0.95)
            </button>
            <button
              className="preset-pill"
              onClick={() => {
                setPromptInput('What is the speed of light in a vacuum?');
                handleExecuteQuery('What is the speed of light in a vacuum?');
              }}
            >
              3. Unrelated Query (Miss)
            </button>
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <input
              type="text"
              className="query-input"
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              placeholder="Enter an LLM prompt to query through DistriCache Gateway..."
              onKeyDown={(e) => e.key === 'Enter' && handleExecuteQuery()}
            />
            <button
              className="btn btn-primary"
              onClick={() => handleExecuteQuery()}
              disabled={workbenchLoading}
              style={{ whiteSpace: 'nowrap' }}
            >
              {workbenchLoading ? 'Querying...' : 'Send Query'}
            </button>
          </div>

          {workbenchResult && (
            <div className="result-box">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span className={`status-badge status-${workbenchResult.statusCode}`}>
                    HTTP {workbenchResult.statusCode}
                  </span>
                  <span className={`cache-pill cache-${workbenchResult.cacheStatus.toLowerCase()}`}>
                    X-Cache: {workbenchResult.cacheStatus}
                  </span>
                  {workbenchResult.similarity !== 'N/A' && (
                    <span style={{ color: 'var(--accent-cyan)', fontSize: '12px' }}>
                      Cosine Similarity: {workbenchResult.similarity}
                    </span>
                  )}
                </div>
                <span className="latency-tag latency-fast">
                  {workbenchResult.totalClientLatencyMs} ms total ({workbenchResult.serverLatencyMs}ms gateway)
                </span>
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                {workbenchResult.responseSnippet}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Real-Time Audit Log Table */}
      <div className="card">
        <div className="card-title">
          <span>Real-Time Audit Log Stream (PostgreSQL)</span>
          <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
            Showing 20 most recent proxied transactions
          </span>
        </div>

        <div className="table-wrapper">
          <table className="audit-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Method</th>
                <th>Request Path</th>
                <th>Status</th>
                <th>Latency</th>
                <th>Cache Header</th>
                <th>Similarity</th>
                <th>Client IP</th>
              </tr>
            </thead>
            <tbody>
              {auditLogs.length > 0 ? (
                auditLogs.map((log) => {
                  const latencyClass =
                    log.latency_ms < 15 ? 'latency-fast' : log.latency_ms < 200 ? 'latency-medium' : 'latency-slow';
                  return (
                    <tr key={log.id}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-dim)' }}>
                        {new Date(log.created_at).toLocaleTimeString()}
                      </td>
                      <td style={{ fontWeight: 600 }}>{log.http_method}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{log.request_path}</td>
                      <td>
                        <span className={`status-badge status-${log.status_code}`}>{log.status_code}</span>
                      </td>
                      <td>
                        <span className={`latency-tag ${latencyClass}`}>{log.latency_ms} ms</span>
                      </td>
                      <td>
                        <span className={`cache-pill cache-${(log.cache_status || 'NONE').toLowerCase()}`}>
                          {log.cache_status || 'NONE'}
                        </span>
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
                        {log.cache_similarity !== null && log.cache_similarity !== undefined
                          ? Number(log.cache_similarity).toFixed(4)
                          : '—'}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-dim)' }}>
                        {log.client_ip}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan="8" style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '24px' }}>
                    No audit logs recorded yet. Send queries via the workbench to populate.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

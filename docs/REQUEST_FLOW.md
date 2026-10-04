# DistriCache — Detailed Request Flows & Sequence Diagrams

This document details the step-by-step lifecycle of incoming requests across all operational scenarios in the DistriCache architecture.

---

## 1. Scenario A: Semantic Cache HIT (Sub-5ms Response)

When a client sends a prompt that is semantically equivalent ($\ge 0.95$ Cosine Similarity) to a previously answered query:

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant GW as Gateway (Node.js)
    participant Redis as Redis Cache
    participant SC as Semantic Cache (FastAPI)
    participant FAISS as FAISS Index
    participant PG as PostgreSQL (Audit)

    Client->>GW: POST /api/v1/llm/query + X-API-Key
    Note over GW: Telemetry timer starts (hrtime)
    GW->>Redis: GET auth:apikey:{hash}
    Redis-->>GW: Client record (Auth OK)
    GW->>Redis: EVALSHA slidingWindowRateLimit (Atomic Lua)
    Redis-->>GW: [allowed=1, remaining=98, reset=59]
    GW->>SC: Proxy POST /api/v1/llm/query
    Note over SC: SentenceTransformer.encode(query, normalize=True)
    SC->>FAISS: index.search(embedding, k=1)
    FAISS-->>SC: (entry_id, similarity=0.984)
    Note over SC: Similarity 0.984 >= Threshold 0.95 -> HIT
    SC->>Redis: GET cache:llm:payload:{entry_id}
    Redis-->>SC: Cached LLM response JSON (<3ms)
    SC-->>GW: HTTP 200 + X-Cache: HIT + X-Cache-Similarity: 0.984
    GW-->>Client: HTTP 200 [Payload] + RateLimit & Cache Headers
    Note over GW: Enqueue audit record to TelemetryBatcher
    GW-)PG: Async batch insert into audit_logs
```

---

## 2. Scenario B: Semantic Cache MISS & Async Indexing

When a client sends a novel query that does not exist in the FAISS vector index:

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant GW as Gateway (Node.js)
    participant SC as Semantic Cache (FastAPI)
    participant FAISS as FAISS Index
    participant Redis as Redis Cache
    participant LLM as Downstream LLM Provider
    participant BG as Background Task Worker

    Client->>GW: POST /api/v1/llm/query + X-API-Key
    GW->>SC: Proxy POST /api/v1/llm/query
    Note over SC: SentenceTransformer.encode(query, normalize=True)
    SC->>FAISS: index.search(embedding, k=1)
    FAISS-->>SC: Best match similarity 0.72 (< 0.95) -> MISS
    SC->>LLM: POST /v1/chat/completions
    Note over LLM: Downstream model generates completion (500-1500ms)
    LLM-->>SC: Generated completion JSON
    SC-->>GW: HTTP 200 + X-Cache: MISS
    GW-->>Client: HTTP 200 + Payload streamed immediately
    SC-)BG: Trigger Background Task: index_entry(query, payload)
    Note over BG: FAISS lock acquired
    BG->>FAISS: index.add(embedding) + record metadata
    BG->>Redis: SETEX cache:llm:payload:{new_id} 86400 payload
    Note over BG: Vector state asynchronously persisted to disk
```

---

## 3. Scenario C: Rate Limit Exceeded (HTTP 429 Too Many Requests)

When a client exceeds their tier allowance within the active sliding window:

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant GW as Gateway (Node.js)
    participant Redis as Redis (Sliding Window Log)

    Client->>GW: GET /api/v1/mock/products + X-API-Key
    GW->>Redis: EVALSHA slidingWindowRateLimit (Atomic Lua)
    Note over Redis: ZREMRANGEBYSCORE: purge old timestamps<br/>ZCARD count: 10 >= limit (10)<br/>ZRANGE 0 0: calculate oldest timestamp wait time
    Redis-->>GW: [allowed=0, remaining=0, retry_after=14]
    GW-->>Client: HTTP 429 Too Many Requests<br/>X-RateLimit-Limit: 10<br/>X-RateLimit-Remaining: 0<br/>Retry-After: 14
    Note over Client: Fast-rejected without contacting downstream service
```

---

## 4. Scenario D: Downstream Failure & Circuit Breaker Tripping

When a downstream service degrades and consecutive errors exceed the threshold:

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant GW as Gateway Circuit Breaker
    participant Target as Downstream Service
    participant PG as PostgreSQL (Events)

    Note over GW: Circuit State: CLOSED (failures = 4)
    Client->>GW: GET /api/v1/mock/products
    GW->>Target: Forward HTTP request
    Target-->>GW: HTTP 500 Internal Server Error
    Note over GW: Failure 5 recorded within rolling 10s window.<br/>Threshold (5) exceeded!
    Note over GW: State Transition: CLOSED -> OPEN
    GW-)PG: INSERT INTO circuit_breaker_events (CLOSED -> OPEN)
    GW-->>Client: HTTP 502 Bad Gateway

    Note over Client, Target: Subsequent requests during recoveryTimeoutMs:
    Client->>GW: GET /api/v1/mock/products
    Note over GW: Circuit is OPEN! Fast-fail immediately.
    GW-->>Client: HTTP 503 Service Unavailable (X-Circuit-Breaker: OPEN)
    Note over Target: No network traffic reaches downstream service, enabling recovery.
```

---

## 5. Scenario E: Circuit Breaker Recovery (HALF_OPEN -> CLOSED)

After the recovery cooldown expires:

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant GW as Gateway Circuit Breaker
    participant Target as Downstream Service
    participant PG as PostgreSQL (Events)

    Note over GW: recoveryTimeoutMs (15s) elapses.<br/>Circuit enters HALF_OPEN.
    Client->>GW: GET /api/v1/mock/products
    Note over GW: Single trial probe allowed through.
    GW->>Target: Forward probe request
    Target-->>GW: HTTP 200 OK
    Note over GW: Probe succeeded! Reset failure counters.<br/>State Transition: HALF_OPEN -> CLOSED
    GW-)PG: INSERT INTO circuit_breaker_events (HALF_OPEN -> CLOSED)
    GW-->>Client: HTTP 200 OK (X-Circuit-Breaker: CLOSED)
```

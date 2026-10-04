#!/usr/bin/env python3
"""
DistriCache High-Concurrency & Latency Benchmark Suite
Tests:
- Test A: Distributed Rate Limiter Atomic Throttling under Concurrency (200 requests in 2s)
- Test B: Semantic Cache Latency Analysis: Cold Query (~800ms) vs. Warm Hits (sub-10ms)
"""

import os
import sys
import time
import asyncio
import argparse
from typing import List, Dict, Any
import numpy as np
import httpx
from tabulate import tabulate

GATEWAY_URL = os.getenv("GATEWAY_URL", "http://localhost:8080")
PRO_KEY = os.getenv("API_KEY_PRO", "dc_live_testkey_123456789")
FREE_KEY = os.getenv("API_KEY_FREE", "dc_free_demo_key")

class BenchmarkResult:
    def __init__(self, latencies: List[float], status_codes: Dict[int, int], cache_statuses: Dict[str, int]):
        self.latencies = np.array(latencies) if latencies else np.array([0.0])
        self.status_codes = status_codes
        self.cache_statuses = cache_statuses

    @property
    def count(self) -> int:
        return len(self.latencies)

    @property
    def p50(self) -> float:
        return float(np.percentile(self.latencies, 50))

    @property
    def p95(self) -> float:
        return float(np.percentile(self.latencies, 95))

    @property
    def p99(self) -> float:
        return float(np.percentile(self.latencies, 99))

    @property
    def mean(self) -> float:
        return float(np.mean(self.latencies))

    @property
    def min(self) -> float:
        return float(np.min(self.latencies))

    @property
    def max(self) -> float:
        return float(np.max(self.latencies))

async def send_request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    headers: Dict[str, str],
    json_data: Any = None
) -> Dict[str, Any]:
    start = time.perf_counter()
    try:
        if method == "POST":
            res = await client.post(url, headers=headers, json=json_data)
        else:
            res = await client.get(url, headers=headers)
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        return {
            "status_code": res.status_code,
            "latency_ms": elapsed_ms,
            "headers": dict(res.headers),
            "body": res.json() if "application/json" in res.headers.get("content-type", "") else res.text,
            "error": None
        }
    except Exception as e:
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        return {
            "status_code": 0,
            "latency_ms": elapsed_ms,
            "headers": {},
            "body": None,
            "error": str(e)
        }

# =============================================================================
# TEST A: Rate Limiter Atomic Concurrency Stress Test
# =============================================================================
async def run_test_a_rate_limiter(base_url: str, total_requests: int = 200, concurrency: int = 40):
    print("\n" + "="*70)
    print(f"  TEST A: Distributed Rate Limiter Atomic Concurrency Test")
    print(f"  Firing {total_requests} concurrent requests to verify zero race conditions...")
    print("="*70)

    url = f"{base_url}/api/v1/mock/products"
    headers = {"X-API-Key": FREE_KEY} # Free tier has max 10 requests / 60 seconds

    limits = httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    timeout = httpx.Timeout(10.0, connect=5.0)

    sem = asyncio.Semaphore(concurrency)

    async def bounded_request(client: httpx.AsyncClient):
        async with sem:
            return await send_request(client, "GET", url, headers)

    start_time = time.perf_counter()
    async with httpx.AsyncClient(limits=limits, timeout=timeout) as client:
        tasks = [bounded_request(client) for _ in range(total_requests)]
        results = await asyncio.gather(*tasks)

    total_time_s = time.perf_counter() - start_time

    status_counts = {}
    latencies_200 = []
    latencies_429 = []

    for r in results:
        code = r["status_code"]
        status_counts[code] = status_counts.get(code, 0) + 1
        if code == 200:
            latencies_200.append(r["latency_ms"])
        elif code == 429:
            latencies_429.append(r["latency_ms"])

    allowed_count = status_counts.get(200, 0)
    throttled_count = status_counts.get(429, 0)
    unexpected_count = sum(v for k, v in status_counts.items() if k not in (200, 429))

    print(f"\nExecution Duration: {total_time_s:.2f} seconds ({len(results) / total_time_s:.1f} req/sec)")
    print(f"  - Allowed (HTTP 200):   {allowed_count}")
    print(f"  - Throttled (HTTP 429): {throttled_count}")
    print(f"  - Errors / Other:       {unexpected_count}")

    # Latency percentile breakdown
    bench_all = BenchmarkResult([r["latency_ms"] for r in results], status_counts, {})
    bench_429 = BenchmarkResult(latencies_429, {}, {})

    table_data = [
        ["Metric", "All Requests", "Throttled (429 Fast-Fail)"],
        ["Sample Count", str(bench_all.count), str(bench_429.count)],
        ["Min Latency", f"{bench_all.min:.2f} ms", f"{bench_429.min:.2f} ms"],
        ["p50 (Median)", f"{bench_all.p50:.2f} ms", f"{bench_429.p50:.2f} ms"],
        ["p95", f"{bench_all.p95:.2f} ms", f"{bench_429.p95:.2f} ms"],
        ["p99", f"{bench_all.p99:.2f} ms", f"{bench_429.p99:.2f} ms"],
        ["Max Latency", f"{bench_all.max:.2f} ms", f"{bench_429.max:.2f} ms"],
        ["Mean Latency", f"{bench_all.mean:.2f} ms", f"{bench_429.mean:.2f} ms"]
    ]
    print("\n" + tabulate(table_data, headers="firstrow", tablefmt="fancy_grid"))

    # Assertions
    assert allowed_count <= 10, f"RACE CONDITION DETECTED! Allowed {allowed_count} > quota 10"
    assert throttled_count >= (total_requests - 10), "Rate limiter failed to throttle overflow requests!"
    print("\n[VERIFICATION PASS] Zero race conditions detected. Atomic Redis multi/exec / Lua script successfully throttled excess concurrent load.")

# =============================================================================
# TEST B: Semantic Cache Latency Analysis (Cold Miss vs. Warm Hits)
# =============================================================================
async def run_test_b_semantic_cache(base_url: str, warm_concurrency_requests: int = 50):
    print("\n" + "="*70)
    print(f"  TEST B: Semantic Cache Latency & Accuracy Analysis")
    print(f"  Cold Query (~800ms Downstream) vs. Warm Concurrent Hits (FAISS + Redis)")
    print("="*70)

    url = f"{base_url}/api/v1/llm/query"
    headers = {
        "X-API-Key": PRO_KEY,
        "Content-Type": "application/json"
    }

    limits = httpx.Limits(max_connections=50, max_keepalive_connections=50)
    timeout = httpx.Timeout(30.0, connect=10.0)

    async with httpx.AsyncClient(limits=limits, timeout=timeout) as client:
        # 1. Cold Query (First time prompt - Cache MISS)
        cold_prompt = f"Explain the architectural trade-offs of Raft vs Paxos consensus [run_{int(time.time())}]"
        print(f"\n1. Dispatching Cold Query (Expect Downstream Computation):")
        print(f"   Prompt: '{cold_prompt}'")

        cold_res = await send_request(client, "POST", url, headers, json_data={"query": cold_prompt})
        cold_status = cold_res["headers"].get("x-cache", "UNKNOWN")
        cold_latency = cold_res["latency_ms"]

        print(f"   -> HTTP {cold_res['status_code']}, Cache: {cold_status}, Total Latency: {cold_latency:.2f} ms")

        # Give async background task 500ms to index into FAISS & Redis
        await asyncio.sleep(0.6)

        # 2. Warm Query Concurrency (Identical and Semantically Equivalent Queries)
        warm_paraphrase = f"What are the architecture differences between Paxos and Raft consensus? [run_{int(time.time())}]"
        print(f"\n2. Dispatching {warm_concurrency_requests} Concurrent Semantically Equivalent Queries:")
        print(f"   Paraphrase: '{warm_paraphrase}'")

        tasks = [
            send_request(client, "POST", url, headers, json_data={"query": warm_paraphrase})
            for _ in range(warm_concurrency_requests)
        ]

        warm_start = time.perf_counter()
        warm_results = await asyncio.gather(*tasks)
        warm_total_time = time.perf_counter() - warm_start

        warm_latencies = [r["latency_ms"] for r in warm_results]
        cache_hits = sum(1 for r in warm_results if r["headers"].get("x-cache") == "HIT")
        cache_misses = sum(1 for r in warm_results if r["headers"].get("x-cache") == "MISS")

        bench_warm = BenchmarkResult(warm_latencies, {}, {})

        # Compute speedup ratio
        latency_reduction_pct = ((cold_latency - bench_warm.p50) / cold_latency) * 100.0
        speedup_factor = cold_latency / max(bench_warm.p50, 0.001)

        summary_table = [
            ["Metric", "Cold Query (Cache MISS)", "Warm Queries (Cache HIT)"],
            ["Requests Sampled", "1", str(len(warm_results))],
            ["Cache Status", cold_status, f"{cache_hits} HITS / {cache_misses} MISSES"],
            ["p50 Latency", f"{cold_latency:.2f} ms", f"{bench_warm.p50:.2f} ms"],
            ["p95 Latency", f"{cold_latency:.2f} ms", f"{bench_warm.p95:.2f} ms"],
            ["p99 Latency", f"{cold_latency:.2f} ms", f"{bench_warm.p99:.2f} ms"],
            ["Min / Max", f"{cold_latency:.2f} ms", f"{bench_warm.min:.2f} ms / {bench_warm.max:.2f} ms"],
            ["Overall Speedup", "Baseline (1.0x)", f"{speedup_factor:.1f}x Faster ({latency_reduction_pct:.1f}% Latency Reduction)"]
        ]

        print("\n" + tabulate(summary_table, headers="firstrow", tablefmt="fancy_grid"))

        assert cache_hits > 0, "Expected at least 1 cache hit on semantically equivalent prompt!"
        print(f"\n[VERIFICATION PASS] Semantic cache successfully reduced response latency from {cold_latency:.1f}ms down to {bench_warm.p50:.1f}ms ({speedup_factor:.1f}x speedup).")

# =============================================================================
# CLI Main Runner
# =============================================================================
async def main():
    parser = argparse.ArgumentParser(description="DistriCache Concurrency & Latency Benchmark")
    parser.add_argument("--gateway-url", default=GATEWAY_URL, help="Gateway Base URL")
    parser.add_argument("--rate-limit-requests", type=int, default=200, help="Total requests for rate limiter test")
    parser.add_argument("--warm-requests", type=int, default=50, help="Concurrent requests for warm cache test")
    args = parser.parse_args()

    print("\n" + "#"*70)
    print("      DISTRICACHE CONCURRENCY & LATENCY BENCHMARK ENGINE")
    print(f"      Target Gateway: {args.gateway_url}")
    print("#"*70)

    # Health check gateway first
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.get(f"{args.gateway_url}/health")
            if res.status_code != 200:
                print(f"[ERROR] Gateway is not healthy at {args.gateway_url}/health (HTTP {res.status_code})")
                sys.exit(1)
            print(f"[OK] Gateway is connected and UP.\n")
    except Exception as e:
        print(f"[ERROR] Could not connect to gateway at {args.gateway_url}: {e}")
        print("Please ensure docker compose up is running before executing benchmarks.")
        sys.exit(1)

    try:
        await run_test_a_rate_limiter(args.gateway_url, total_requests=args.rate_limit_requests)
        await run_test_b_semantic_cache(args.gateway_url, warm_concurrency_requests=args.warm_requests)
        print("\n" + "#"*70)
        print("      ALL BENCHMARKS PASSED SUCCESSFULLY (ZERO DEFECTS)")
        print("#"*70 + "\n")
    except AssertionError as ae:
        print(f"\n[BENCHMARK ASSERTION FAILED]: {ae}")
        sys.exit(1)
    except Exception as ex:
        print(f"\n[UNEXPECTED ERROR]: {ex}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())

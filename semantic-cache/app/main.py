import time
import logging
from contextlib import asynccontextmanager
from typing import Dict, Any
from fastapi import FastAPI, Request, Response, BackgroundTasks, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.core.embedding import embedding_model
from app.core.faiss_index import faiss_manager
from app.core.redis_client import redis_client
from app.services.cache_service import cache_service
from app.services.proxy_service import proxy_service
from app.schemas.cache import (
    SemanticQueryRequest,
    ChatCompletionRequest,
    CacheQueryResponse,
    CacheStatsResponse,
    InvalidatePatternRequest,
    InvalidateAgeRequest,
    InvalidationResponse
)

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(name)s]: %(message)s"
)
logger = logging.getLogger("semantic_cache.main")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup sequence
    logger.info("Initializing DistriCache Semantic Cache Engine...")
    try:
        embedding_model.load()
        await redis_client.connect()
        faiss_manager.load_from_disk()
        logger.info("DistriCache Semantic Cache Engine started successfully.")
    except Exception as e:
        logger.error(f"Error during startup: {e}")
        raise e

    yield

    # Shutdown sequence
    logger.info("Shutting down DistriCache Semantic Cache Engine...")
    try:
        faiss_manager.save_to_disk()
        await redis_client.disconnect()
        logger.info("Shutdown completed cleanly.")
    except Exception as e:
        logger.error(f"Error during shutdown: {e}")

app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    description="High-Throughput FAISS-backed Semantic Cache Engine for LLMs and Vector Queries",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------------------------------------------------------------
# Health & Diagnostic Endpoints
# ----------------------------------------------------------------------------
@app.get("/health", tags=["Diagnostics"])
async def health():
    return {
        "status": "UP",
        "service": settings.APP_NAME,
        "vectors_indexed": faiss_manager.total_vectors,
        "similarity_threshold": settings.SIMILARITY_THRESHOLD,
        "timestamp": time.time()
    }

@app.get("/cache/stats", response_model=CacheStatsResponse, tags=["Cache Management"])
async def get_stats():
    return cache_service.get_stats()

@app.post("/cache/clear", tags=["Cache Management"])
async def clear_cache():
    faiss_manager.clear()
    cache_service.hits = 0
    cache_service.misses = 0
    return {"message": "FAISS vector cache cleared successfully"}

@app.post("/cache/invalidate/pattern", response_model=InvalidationResponse, tags=["Cache Management"])
async def invalidate_by_pattern(req: InvalidatePatternRequest):
    """Invalidates cached entries matching pattern in Redis and compacts FAISS index non-blockingly."""
    result = await cache_service.invalidate_by_pattern(req.pattern)
    return InvalidationResponse(
        message=f"Cache invalidation for pattern '{req.pattern}' completed successfully.",
        details=result
    )

@app.post("/cache/invalidate/age", response_model=InvalidationResponse, tags=["Cache Management"])
async def invalidate_by_age(req: InvalidateAgeRequest):
    """Evicts vectors older than max_age_seconds and unlinks payloads from Redis."""
    result = await cache_service.invalidate_by_age(req.max_age_seconds)
    return InvalidationResponse(
        message=f"Evicted {result['evicted_count']} entries older than {req.max_age_seconds} seconds.",
        details=result
    )

@app.delete("/cache/entries/{entry_id}", tags=["Cache Management"])
async def delete_entry(entry_id: str):
    """Invalidates a specific cached entry by ID."""
    removed = await cache_service.invalidate_entry(entry_id)
    if not removed:
        raise HTTPException(status_code=404, detail=f"Entry ID {entry_id} not found in cache")
    return {"message": f"Entry {entry_id} invalidated successfully"}

@app.get("/cache/entries", tags=["Cache Management"])
async def list_entries():
    """Lists currently indexed vectors and their metadata."""
    entries = cache_service.list_entries()
    return {
        "count": len(entries),
        "entries": entries
    }

# ----------------------------------------------------------------------------
# Semantic Query Endpoint
# ----------------------------------------------------------------------------
@app.post("/api/v1/llm/query", tags=["Semantic LLM Cache"])
async def semantic_query(
    request: SemanticQueryRequest,
    response: Response,
    background_tasks: BackgroundTasks
):
    start_time = time.perf_counter()
    query_text = request.query

    # 1. Query semantic cache
    cache_status, similarity, entry_id, cached_payload = await cache_service.check_cache(query_text)
    latency_ms = (time.perf_counter() - start_time) * 1000.0

    if cache_status == "HIT":
        response.headers["X-Cache"] = "HIT"
        response.headers["X-Cache-Similarity"] = f"{similarity:.4f}"
        response.headers["X-Cache-Latency-Ms"] = f"{latency_ms:.2f}"
        response.headers["X-Cache-Entry-Id"] = entry_id

        return CacheQueryResponse(
            cache_status="HIT",
            similarity_score=similarity,
            matched_entry_id=entry_id,
            response_payload=cached_payload,
            latency_ms=round(latency_ms, 3)
        )

    # 2. Cache MISS: Proxy to downstream LLM service
    try:
        status_code, downstream_data = await proxy_service.forward_request({
            "prompt": query_text,
            "metadata": request.metadata
        })
    except Exception as e:
        logger.error(f"Downstream LLM call failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Downstream LLM backend unavailable: {str(e)}"
        )

    total_latency_ms = (time.perf_counter() - start_time) * 1000.0
    response.headers["X-Cache"] = "MISS"
    if similarity is not None:
        response.headers["X-Cache-Similarity"] = f"{similarity:.4f}"
    response.headers["X-Cache-Latency-Ms"] = f"{total_latency_ms:.2f}"

    # Asynchronously index new embedding and payload without slowing client response
    background_tasks.add_task(
        cache_service.index_entry,
        query_text=query_text,
        payload=downstream_data,
        metadata=request.metadata
    )

    return CacheQueryResponse(
        cache_status="MISS",
        similarity_score=similarity,
        matched_entry_id=None,
        response_payload=downstream_data,
        latency_ms=round(total_latency_ms, 3)
    )

# ----------------------------------------------------------------------------
# OpenAI-Compatible Chat Completions Endpoint
# ----------------------------------------------------------------------------
@app.post("/v1/chat/completions", tags=["OpenAI Compatible"])
async def chat_completions(
    request: ChatCompletionRequest,
    response: Response,
    background_tasks: BackgroundTasks
):
    start_time = time.perf_counter()

    # Extract user prompt from last message
    user_prompt = ""
    for msg in reversed(request.messages):
        if msg.role.lower() == "user":
            user_prompt = msg.content
            break

    if not user_prompt:
        user_prompt = request.messages[-1].content if request.messages else ""

    # 1. Semantic Cache check
    cache_status, similarity, entry_id, cached_payload = await cache_service.check_cache(user_prompt)
    latency_ms = (time.perf_counter() - start_time) * 1000.0

    if cache_status == "HIT":
        response.headers["X-Cache"] = "HIT"
        response.headers["X-Cache-Similarity"] = f"{similarity:.4f}"
        response.headers["X-Cache-Latency-Ms"] = f"{latency_ms:.2f}"
        response.headers["X-Cache-Entry-Id"] = entry_id
        return cached_payload

    # 2. Cache MISS: Proxy to downstream LLM backend
    try:
        status_code, downstream_data = await proxy_service.forward_request(request.dict())
    except Exception as e:
        logger.error(f"Downstream LLM call failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Downstream LLM backend unavailable: {str(e)}"
        )

    total_latency_ms = (time.perf_counter() - start_time) * 1000.0
    response.headers["X-Cache"] = "MISS"
    if similarity is not None:
        response.headers["X-Cache-Similarity"] = f"{similarity:.4f}"
    response.headers["X-Cache-Latency-Ms"] = f"{total_latency_ms:.2f}"

    # Asynchronously index into FAISS & Redis
    background_tasks.add_task(
        cache_service.index_entry,
        query_text=user_prompt,
        payload=downstream_data,
        metadata={"model": request.model}
    )

    return downstream_data

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=settings.DEBUG)

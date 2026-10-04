import time
import random
import asyncio
import logging
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [MockService]: %(message)s"
)
logger = logging.getLogger("mock_service")

app = FastAPI(
    title="DistriCache Downstream Mock Service (FastAPI)",
    version="2.0.0",
    description="Lightweight microservice simulating an expensive LLM/Search API with configurable latency and error rates."
)

# -----------------------------------------------------------------------------
# Configuration State (Mutable at runtime for fault injection)
# -----------------------------------------------------------------------------
class MockServiceConfig:
    def __init__(self):
        self.latency_ms: int = 800          # Default 800ms artificial latency
        self.error_rate: float = 0.0        # Probability of throwing 500 error (0.0 to 1.0)
        self.fail_on_demand: bool = False   # Force 100% failure immediately
        self.failure_status_code: int = 500

config = MockServiceConfig()

class ConfigUpdateRequest(BaseModel):
    latency_ms: Optional[int] = Field(None, ge=0, le=10000, description="Artificial latency in ms")
    error_rate: Optional[float] = Field(None, ge=0.0, le=1.0, description="Error rate between 0.0 and 1.0")
    fail_on_demand: Optional[bool] = Field(None, description="Force 100% 500 failure on demand")
    failure_status_code: Optional[int] = Field(None, ge=400, le=599)

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatCompletionRequest(BaseModel):
    model: Optional[str] = "gpt-4o-mock"
    messages: Optional[List[ChatMessage]] = None
    prompt: Optional[str] = None
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = 512

# -----------------------------------------------------------------------------
# Helper: Inject Latency & Evaluate Faults
# -----------------------------------------------------------------------------
async def apply_fault_injection():
    # 1. Apply configured artificial latency
    if config.latency_ms > 0:
        await asyncio.sleep(config.latency_ms / 1000.0)

    # 2. Check on-demand failure or probabilistic error rate
    should_fail = config.fail_on_demand or (config.error_rate > 0 and random.random() < config.error_rate)

    if should_fail:
        logger.warning(
            f"Fault injected! Returning HTTP {config.failure_status_code} "
            f"(fail_on_demand={config.fail_on_demand}, error_rate={config.error_rate})"
        )
        raise HTTPException(
            status_code=config.failure_status_code,
            detail={
                "error": {
                    "message": "Downstream Service Outage / Internal Server Error (simulated fault)",
                    "type": "internal_error",
                    "code": config.failure_status_code
                }
            }
        )

# -----------------------------------------------------------------------------
# Diagnostics & Dynamic Configuration Endpoints
# -----------------------------------------------------------------------------
@app.get("/health", tags=["Diagnostics"])
async def health():
    if config.fail_on_demand:
        raise HTTPException(status_code=500, detail="Service marked unhealthy (fail_on_demand=True)")
    return {
        "status": "UP",
        "service": "downstream-mock-fastapi",
        "latency_ms": config.latency_ms,
        "error_rate": config.error_rate,
        "fail_on_demand": config.fail_on_demand,
        "timestamp": time.time()
    }

@app.get("/mock/config", tags=["Configuration"])
async def get_config():
    return {
        "latency_ms": config.latency_ms,
        "error_rate": config.error_rate,
        "fail_on_demand": config.fail_on_demand,
        "failure_status_code": config.failure_status_code
    }

@app.post("/mock/config", tags=["Configuration"])
async def update_config(req: ConfigUpdateRequest):
    if req.latency_ms is not None:
        config.latency_ms = req.latency_ms
    if req.error_rate is not None:
        config.error_rate = req.error_rate
    if req.fail_on_demand is not None:
        config.fail_on_demand = req.fail_on_demand
    if req.failure_status_code is not None:
        config.failure_status_code = req.failure_status_code

    logger.info(
        f"Mock service config updated: latency={config.latency_ms}ms, "
        f"error_rate={config.error_rate}, fail_on_demand={config.fail_on_demand}"
    )
    return {
        "message": "Mock configuration updated successfully",
        "config": {
            "latency_ms": config.latency_ms,
            "error_rate": config.error_rate,
            "fail_on_demand": config.fail_on_demand,
            "failure_status_code": config.failure_status_code
        }
    }

# -----------------------------------------------------------------------------
# Simulated Downstream LLM API (/v1/chat/completions)
# -----------------------------------------------------------------------------
@app.post("/v1/chat/completions", tags=["LLM Simulation"])
async def chat_completions(req: ChatCompletionRequest):
    start = time.perf_counter()
    await apply_fault_injection()

    # Extract user prompt
    prompt_text = req.prompt
    if not prompt_text and req.messages:
        for msg in reversed(req.messages):
            if msg.role.lower() == "user":
                prompt_text = msg.content
                break
        if not prompt_text:
            prompt_text = req.messages[-1].content
    if not prompt_text:
        prompt_text = "Default simulated prompt response"

    elapsed_ms = (time.perf_counter() - start) * 1000.0

    return {
        "id": f"chatcmpl-mock-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": req.model or "gpt-4o-mock",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": (
                        f"[Downstream LLM Generated Response]: Computed answer for query '{prompt_text}'. "
                        f"This response took ~{int(elapsed_ms)}ms of expensive model execution."
                    )
                },
                "finish_reason": "stop"
            }
        ],
        "usage": {
            "prompt_tokens": len(prompt_text.split()),
            "completion_tokens": 40,
            "total_tokens": len(prompt_text.split()) + 40
        },
        "downstream_simulated_latency_ms": round(elapsed_ms, 2)
    }

# -----------------------------------------------------------------------------
# Simulated Expensive Search API (/api/v1/mock/search)
# -----------------------------------------------------------------------------
@app.get("/api/v1/mock/search", tags=["Search Simulation"])
async def search(q: str = "distributed systems"):
    await apply_fault_injection()
    return {
        "query": q,
        "results_count": 3,
        "items": [
            {"id": "doc_1", "title": f"Deep Dive: {q}", "score": 0.98},
            {"id": "doc_2", "title": f"Scaling Architectures for {q}", "score": 0.91},
            {"id": "doc_3", "title": f"Fault Tolerance and {q}", "score": 0.85}
        ],
        "execution_time_ms": config.latency_ms
    }

# -----------------------------------------------------------------------------
# General Downstream Microservice Routes (/api/v1/mock/*)
# -----------------------------------------------------------------------------
@app.get("/api/v1/mock/products", tags=["Microservice Endpoints"])
async def get_products():
    await apply_fault_injection()
    return {
        "service": "downstream-products-service",
        "items": [
            {"id": "prod_1", "name": "High-Concurrency Reverse Proxy Appliance", "price": 499.0},
            {"id": "prod_2", "name": "Distributed Sliding-Window Rate Limiter Cluster", "price": 899.0},
            {"id": "prod_3", "name": "FAISS Semantic Cache Engine Node", "price": 1299.0}
        ],
        "simulated_latency_ms": config.latency_ms
    }

@app.post("/api/v1/mock/echo", tags=["Microservice Endpoints"])
async def echo(payload: Dict[str, Any]):
    await apply_fault_injection()
    return {
        "status": "success",
        "received_data": payload,
        "processed_at": time.time()
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8001, reload=False)

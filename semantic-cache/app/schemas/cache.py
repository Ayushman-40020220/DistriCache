from typing import List, Optional, Dict, Any, Union
from pydantic import BaseModel, Field

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatCompletionRequest(BaseModel):
    model: Optional[str] = "districache-llm"
    messages: List[ChatMessage]
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = 512
    stream: Optional[bool] = False

class SemanticQueryRequest(BaseModel):
    query: str = Field(..., description="Prompt or text to search against semantic cache")
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict)
    stream: Optional[bool] = False

class CacheQueryResponse(BaseModel):
    cache_status: str = Field(..., description="HIT or MISS")
    similarity_score: Optional[float] = Field(None, description="Cosine similarity score (0.0 to 1.0)")
    matched_entry_id: Optional[str] = None
    response_payload: Any
    latency_ms: float
    model: Optional[str] = None

class CacheStatsResponse(BaseModel):
    total_vectors: int
    dimension: int
    similarity_threshold: float
    hits: int
    misses: int
    hit_ratio: float

class InvalidatePatternRequest(BaseModel):
    pattern: str = Field(..., description="Glob pattern to match keys/prompts (e.g. '*system*' or 'cache:llm:*')")

class InvalidateAgeRequest(BaseModel):
    max_age_seconds: float = Field(..., ge=0, description="Evict entries older than this many seconds")

class InvalidationResponse(BaseModel):
    message: str
    details: Dict[str, Any]

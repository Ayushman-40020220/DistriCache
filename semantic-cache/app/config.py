import os
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    APP_NAME: str = "DistriCache Semantic LLM Cache Engine"
    DEBUG: bool = False
    PORT: int = 8000
    HOST: str = "0.0.0.0"

    # AI & Embedding Model
    MODEL_NAME: str = "sentence-transformers/all-MiniLM-L6-v2"
    EMBEDDING_DIM: int = 384
    SIMILARITY_THRESHOLD: float = 0.95

    # Storage & Redis
    REDIS_URL: str = "redis://redis:6379/0"
    CACHE_TTL_SECONDS: int = 86400  # 24 hours
    INDEX_STORAGE_PATH: str = "/data/faiss_index.bin"
    METADATA_STORAGE_PATH: str = "/data/faiss_metadata.json"

    # Downstream Backend Service
    DOWNSTREAM_LLM_URL: str = "http://mock-service:8001/v1/chat/completions"
    DOWNSTREAM_TIMEOUT_SECONDS: float = 30.0

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"

settings = Settings()

import uuid
import logging
import asyncio
from typing import Optional, Tuple, Any, Dict
from app.config import settings
from app.core.embedding import embedding_model
from app.core.faiss_index import faiss_manager
from app.core.redis_client import redis_client

logger = logging.getLogger("semantic_cache.service")

class SemanticCacheService:
    def __init__(self):
        self.hits = 0
        self.misses = 0

    async def check_cache(self, query_text: str) -> Tuple[str, Optional[float], Optional[str], Optional[Any]]:
        """
        Executes semantic cache check:
        1. Encodes query into dense unit-vector embedding
        2. Queries FAISS IndexFlatIP (Cosine Similarity)
        3. If similarity >= threshold (0.95), fetches cached payload from Redis
        Returns: (cache_status, similarity_score, entry_id, payload)
        """
        clean_text = query_text.strip()
        if not clean_text or faiss_manager.total_vectors == 0:
            self.misses += 1
            return "MISS", None, None, None

        # Compute normalized embedding
        embedding = embedding_model.encode(clean_text)

        # Search FAISS index
        search_result = faiss_manager.search(embedding, k=1)
        if not search_result:
            self.misses += 1
            return "MISS", None, None, None

        entry_id, similarity, meta = search_result

        # Check threshold (0.95)
        if similarity >= settings.SIMILARITY_THRESHOLD:
            # Sub-5ms Redis payload retrieval
            payload = await redis_client.get_payload(entry_id)
            if payload is not None:
                self.hits += 1
                logger.info(
                    f"Semantic Cache HIT! Similarity: {similarity:.4f} >= {settings.SIMILARITY_THRESHOLD} "
                    f"(matched '{meta.get('prompt', '')[:40]}...')"
                )
                return "HIT", similarity, entry_id, payload
            else:
                logger.warn(f"FAISS match found ({similarity:.4f}) but payload expired from Redis ({entry_id}).")

        self.misses += 1
        logger.info(f"Semantic Cache MISS. Best similarity: {similarity:.4f} < {settings.SIMILARITY_THRESHOLD}")
        return "MISS", similarity, None, None

    async def index_entry(self, query_text: str, payload: Any, metadata: Optional[Dict[str, Any]] = None) -> str:
        """
        Asynchronously indexes new prompt into FAISS and stores payload in Redis.
        """
        clean_text = query_text.strip()
        entry_id = str(uuid.uuid4())

        # 1. Compute embedding
        embedding = embedding_model.encode(clean_text)

        # 2. Add to FAISS index
        faiss_manager.add(entry_id, embedding, clean_text, metadata)

        # 3. Store in Redis with TTL
        await redis_client.set_payload(entry_id, payload, settings.CACHE_TTL_SECONDS)

        # 4. Periodically trigger index save to disk (as background task)
        if faiss_manager.total_vectors % 5 == 0:
            asyncio.get_event_loop().run_in_executor(None, faiss_manager.save_to_disk)

        logger.info(f"Indexed entry {entry_id} into FAISS & Redis (total: {faiss_manager.total_vectors})")
        return entry_id

    def get_stats(self) -> Dict[str, Any]:
        total = self.hits + self.misses
        hit_ratio = (self.hits / total) if total > 0 else 0.0
        return {
            "total_vectors": faiss_manager.total_vectors,
            "dimension": settings.EMBEDDING_DIM,
            "similarity_threshold": settings.SIMILARITY_THRESHOLD,
            "hits": self.hits,
            "misses": self.misses,
            "hit_ratio": round(hit_ratio, 4)
        }

    async def invalidate_entry(self, entry_id: str) -> bool:
        """Deletes a specific entry from both Redis and FAISS index."""
        await redis_client.delete_payload(entry_id)
        count, _ = faiss_manager.evict_by_entry_ids({entry_id})
        logger.info(f"Invalidated cache entry {entry_id} (FAISS evicted={count})")
        return count > 0

    async def invalidate_by_age(self, max_age_seconds: float) -> Dict[str, Any]:
        """Evicts entries older than max_age_seconds from FAISS and unlinks payloads from Redis."""
        evicted_count, evicted_ids = faiss_manager.evict_by_age(max_age_seconds)
        if evicted_ids:
            await redis_client.delete_multiple(evicted_ids)
        logger.info(f"Age-based invalidation complete: {evicted_count} entries removed (> {max_age_seconds}s)")
        return {
            "evicted_count": evicted_count,
            "evicted_entry_ids": evicted_ids,
            "remaining_vectors": faiss_manager.total_vectors
        }

    async def invalidate_by_pattern(self, pattern: str) -> Dict[str, Any]:
        """Evicts entries matching glob pattern across Redis keys and FAISS prompts."""
        # 1. Redis pattern purge
        redis_purged = await redis_client.delete_by_pattern(pattern)

        # 2. FAISS vector eviction
        evicted_count, evicted_ids = faiss_manager.evict_by_pattern(pattern)
        if evicted_ids:
            await redis_client.delete_multiple(evicted_ids)

        logger.info(f"Pattern invalidation ('{pattern}'): {evicted_count} FAISS vectors, {redis_purged} Redis keys purged.")
        return {
            "pattern": pattern,
            "faiss_evicted_count": evicted_count,
            "redis_keys_purged": redis_purged,
            "remaining_vectors": faiss_manager.total_vectors
        }

    def list_entries(self) -> list:
        return faiss_manager.get_all_entries()

cache_service = SemanticCacheService()


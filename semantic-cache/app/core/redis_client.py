import json
import logging
from typing import Optional, Any
import redis.asyncio as aioredis
from app.config import settings

logger = logging.getLogger("semantic_cache.redis")

class RedisClient:
    def __init__(self, redis_url: str = settings.REDIS_URL):
        self.redis_url = redis_url
        self.client: Optional[aioredis.Redis] = None

    async def connect(self):
        if self.client is None:
            logger.info(f"Connecting to Redis at {self.redis_url}...")
            self.client = aioredis.from_url(
                self.redis_url,
                encoding="utf-8",
                decode_responses=True,
                max_connections=20
            )
            await self.client.ping()
            logger.info("Connected to Redis successfully.")

    async def disconnect(self):
        if self.client is not None:
            await self.client.close()
            logger.info("Redis connection closed.")

    async def get_payload(self, entry_id: str) -> Optional[Any]:
        if not self.client:
            await self.connect()
        key = f"cache:llm:payload:{entry_id}"
        val = await self.client.get(key)
        if val:
            try:
                return json.loads(val)
            except json.JSONDecodeError:
                return val
        return None

    async def set_payload(self, entry_id: str, payload: Any, ttl: int = settings.CACHE_TTL_SECONDS) -> bool:
        if not self.client:
            await self.connect()
        key = f"cache:llm:payload:{entry_id}"
        serialized = json.dumps(payload) if isinstance(payload, (dict, list)) else str(payload)
        await self.client.setex(key, ttl, serialized)
        return True

    async def delete_payload(self, entry_id: str) -> bool:
        if not self.client:
            await self.connect()
        key = f"cache:llm:payload:{entry_id}"
        return await self.client.delete(key) > 0

    async def delete_by_pattern(self, pattern: str) -> int:
        """Scan and delete keys matching pattern using Redis UNLINK (non-blocking)."""
        if not self.client:
            await self.connect()
        deleted_count = 0
        cursor = "0"
        while True:
            cursor, keys = await self.client.scan(cursor=cursor, match=pattern, count=100)
            if keys:
                deleted = await self.client.unlink(*keys)
                deleted_count += deleted
            if cursor == 0 or cursor == "0":
                break
        logger.info(f"Unlinked {deleted_count} keys matching pattern '{pattern}' in Redis.")
        return deleted_count

    async def delete_multiple(self, entry_ids: list) -> int:
        if not self.client:
            await self.connect()
        if not entry_ids:
            return 0
        keys = [f"cache:llm:payload:{eid}" for eid in entry_ids]
        return await self.client.unlink(*keys)

redis_client = RedisClient()

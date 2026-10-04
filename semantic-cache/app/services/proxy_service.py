import logging
from typing import Dict, Any, Tuple
import httpx
from app.config import settings

logger = logging.getLogger("semantic_cache.proxy")

class ProxyService:
    def __init__(self, target_url: str = settings.DOWNSTREAM_LLM_URL, timeout: float = settings.DOWNSTREAM_TIMEOUT_SECONDS):
        self.target_url = target_url
        self.timeout = timeout

    async def forward_request(self, payload: Dict[str, Any], headers: Dict[str, str] = None) -> Tuple[int, Any]:
        """
        Proxies request payload to downstream LLM backend service.
        Returns: (status_code, response_data)
        """
        request_headers = {
            "Content-Type": "application/json",
            "User-Agent": "DistriCache-Semantic-Cache-Proxy"
        }
        if headers:
            for k, v in headers.items():
                if k.lower() not in ["content-length", "host"]:
                    request_headers[k] = v

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                logger.info(f"Forwarding cache MISS to downstream LLM: {self.target_url}")
                res = await client.post(self.target_url, json=payload, headers=request_headers)
                
                try:
                    data = res.json()
                except Exception:
                    data = res.text

                return res.status_code, data
        except httpx.TimeoutException as e:
            logger.error(f"Downstream LLM timed out after {self.timeout}s: {e}")
            raise RuntimeError(f"Downstream LLM service timed out: {e}")
        except httpx.RequestError as e:
            logger.error(f"Downstream LLM network error: {e}")
            raise RuntimeError(f"Downstream LLM network error: {e}")

proxy_service = ProxyService()

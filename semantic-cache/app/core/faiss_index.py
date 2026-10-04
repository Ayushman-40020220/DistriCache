import os
import time
import json
import fnmatch
import logging
import threading
from typing import Optional, Tuple, Dict, Any, List, Set
import numpy as np
import faiss
from app.config import settings

logger = logging.getLogger("semantic_cache.faiss")

class FaissIndexManager:
    """
    Thread-safe, non-blocking FAISS vector index manager.
    Implements Read-Copy-Update (RCU) / Atomic Pointer Swapping for index
    compaction and vector eviction, ensuring concurrent search queries are NEVER blocked.
    """
    def __init__(
        self,
        dimension: int = settings.EMBEDDING_DIM,
        index_path: str = settings.INDEX_STORAGE_PATH,
        metadata_path: str = settings.METADATA_STORAGE_PATH
    ):
        self.dimension = dimension
        self.index_path = index_path
        self.metadata_path = metadata_path
        self.write_lock = threading.Lock()

        # Active FAISS Index (IndexFlatIP for exact Cosine Similarity on unit vectors)
        self.index = faiss.IndexFlatIP(self.dimension)
        # Position offset -> metadata mapping: { 0: { "entry_id": ..., "prompt": ..., "created_at": ... } }
        self.metadata_map: Dict[int, Dict[str, Any]] = {}

    def load_from_disk(self):
        """Loads FAISS index and metadata map from disk if available."""
        with self.write_lock:
            if os.path.exists(self.index_path) and os.path.exists(self.metadata_path):
                try:
                    logger.info(f"Loading FAISS index from {self.index_path}...")
                    loaded_index = faiss.read_index(self.index_path)
                    with open(self.metadata_path, "r", encoding="utf-8") as f:
                        raw_meta = json.load(f)
                        loaded_meta = {int(k): v for k, v in raw_meta.items()}
                    # Atomic swap
                    self.index = loaded_index
                    self.metadata_map = loaded_meta
                    logger.info(f"Loaded FAISS index with {self.index.ntotal} vectors.")
                except Exception as e:
                    logger.error(f"Failed to load FAISS index from disk: {e}. Initializing fresh index.")
                    self.index = faiss.IndexFlatIP(self.dimension)
                    self.metadata_map = {}
            else:
                logger.info("No existing FAISS index on disk. Initialized fresh IndexFlatIP.")

    def save_to_disk(self):
        """Persists FAISS index and metadata map to disk."""
        try:
            os.makedirs(os.path.dirname(self.index_path), exist_ok=True)
            os.makedirs(os.path.dirname(self.metadata_path), exist_ok=True)
            # Capture local reference
            index_snapshot = self.index
            meta_snapshot = dict(self.metadata_map)

            faiss.write_index(index_snapshot, self.index_path)
            with open(self.metadata_path, "w", encoding="utf-8") as f:
                json.dump(meta_snapshot, f)
            logger.info(f"Saved FAISS index ({index_snapshot.ntotal} vectors) to {self.index_path}.")
        except Exception as e:
            logger.error(f"Failed to save FAISS index to disk: {e}")

    def search(self, query_embedding: np.ndarray, k: int = 1) -> Optional[Tuple[str, float, Dict[str, Any]]]:
        """
        NON-BLOCKING READ SEARCH:
        Captures local references to self.index and self.metadata_map.
        Does NOT acquire self.write_lock, enabling massive read concurrency
        even while background eviction or additions occur.
        """
        active_index = self.index
        active_meta = self.metadata_map

        if active_index.ntotal == 0:
            return None

        # FAISS search in C++ is thread-safe for concurrent read queries
        scores, indices = active_index.search(query_embedding, k)

        best_score = float(scores[0][0])
        best_idx = int(indices[0][0])

        if best_idx < 0 or best_idx not in active_meta:
            return None

        meta = active_meta[best_idx]
        return meta["entry_id"], best_score, meta

    def add(self, entry_id: str, embedding: np.ndarray, prompt: str, metadata: Optional[Dict[str, Any]] = None) -> int:
        """
        Thread-safely appends a new vector to the active FAISS index.
        """
        with self.write_lock:
            idx = int(self.index.ntotal)
            self.index.add(embedding)
            self.metadata_map[idx] = {
                "entry_id": entry_id,
                "prompt": prompt,
                "created_at": time.time(),
                "metadata": metadata or {}
            }
            logger.debug(f"Added vector idx={idx}, entry_id={entry_id} to FAISS. Total={self.index.ntotal}")
            return idx

    def evict_by_entry_ids(self, entry_ids: Set[str]) -> Tuple[int, List[str]]:
        """
        Asynchronous Non-Blocking Compaction & Eviction:
        Builds a fresh FAISS index with only the surviving vectors,
        then atomically swaps references so in-flight readers never stall.
        """
        if not entry_ids:
            return 0, []

        with self.write_lock:
            old_index = self.index
            old_meta = self.metadata_map
            total = old_index.ntotal

            if total == 0:
                return 0, []

            survivor_indices = []
            evicted_ids = []

            for idx, meta in old_meta.items():
                if meta["entry_id"] in entry_ids:
                    evicted_ids.append(meta["entry_id"])
                else:
                    survivor_indices.append(idx)

            if not evicted_ids:
                return 0, []

            new_index = faiss.IndexFlatIP(self.dimension)
            new_meta = {}

            if survivor_indices:
                # Reconstruct surviving vectors
                surviving_vectors = []
                for new_offset, old_offset in enumerate(survivor_indices):
                    vec = old_index.reconstruct(int(old_offset))
                    surviving_vectors.append(vec)
                    new_meta[new_offset] = old_meta[old_offset]

                stacked_vectors = np.array(surviving_vectors, dtype=np.float32)
                new_index.add(stacked_vectors)

            # Atomic swap of index pointer and metadata
            self.index = new_index
            self.metadata_map = new_meta

            logger.info(
                f"FAISS Compaction complete. Evicted {len(evicted_ids)} vectors. "
                f"Active vectors: {self.index.ntotal} (was {total})."
            )

        # Trigger disk save
        self.save_to_disk()
        return len(evicted_ids), evicted_ids

    def evict_by_age(self, max_age_seconds: float) -> Tuple[int, List[str]]:
        """Evicts vectors older than max_age_seconds."""
        cutoff = time.time() - max_age_seconds
        target_ids = set()

        for meta in self.metadata_map.values():
            created_at = meta.get("created_at") or 0.0
            if created_at < cutoff:
                target_ids.add(meta["entry_id"])

        return self.evict_by_entry_ids(target_ids)

    def evict_by_pattern(self, pattern: str) -> Tuple[int, List[str]]:
        """Evicts vectors whose prompt or entry_id matches a glob pattern."""
        target_ids = set()
        for meta in self.metadata_map.values():
            if fnmatch.fnmatch(meta["entry_id"], pattern) or fnmatch.fnmatch(meta.get("prompt", ""), pattern):
                target_ids.add(meta["entry_id"])

        return self.evict_by_entry_ids(target_ids)

    def get_all_entries(self) -> List[Dict[str, Any]]:
        """Returns list of currently indexed items."""
        return list(self.metadata_map.values())

    def clear(self):
        """Resets the FAISS index and wipes disk persistence."""
        with self.write_lock:
            self.index = faiss.IndexFlatIP(self.dimension)
            self.metadata_map.clear()
            if os.path.exists(self.index_path):
                os.remove(self.index_path)
            if os.path.exists(self.metadata_path):
                os.remove(self.metadata_path)
            logger.info("Cleared FAISS index and disk storage.")

    @property
    def total_vectors(self) -> int:
        return self.index.ntotal

faiss_manager = FaissIndexManager()

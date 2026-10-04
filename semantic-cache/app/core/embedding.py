import logging
import numpy as np
from sentence_transformers import SentenceTransformer
from app.config import settings

logger = logging.getLogger("semantic_cache.embedding")

class EmbeddingModel:
    def __init__(self, model_name: str = settings.MODEL_NAME):
        self.model_name = model_name
        self._model = None

    def load(self):
        if self._model is None:
            logger.info(f"Loading SentenceTransformer model: {self.model_name}...")
            self._model = SentenceTransformer(self.model_name)
            logger.info("SentenceTransformer model loaded successfully.")

    def encode(self, text: str) -> np.ndarray:
        """
        Computes a dense vector embedding normalized to unit L2 length.
        Inner product of two normalized vectors equals their Cosine Similarity.
        """
        if self._model is None:
            self.load()
        # normalize_embeddings=True ensures ||v||_2 = 1.0
        embedding = self._model.encode(
            text,
            convert_to_numpy=True,
            normalize_embeddings=True
        )
        # Ensure 2D float32 array: shape (1, dimension)
        if embedding.ndim == 1:
            embedding = np.expand_dims(embedding, axis=0)
        return embedding.astype(np.float32)

embedding_model = EmbeddingModel()

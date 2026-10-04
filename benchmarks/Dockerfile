FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY benchmark.py .

ENV PYTHONUNBUFFERED=1 \
    GATEWAY_URL=http://gateway:8080

ENTRYPOINT ["python", "benchmark.py"]

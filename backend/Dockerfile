# API service image (Railway root directory: /backend).
FROM python:3.12-slim

# OpenCascade (cadquery-ocp), VTK and matplotlib need these shared libraries.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libxrender1 libxext6 libsm6 libx11-6 libgomp1 libfontconfig1 libfreetype6 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app/backend

COPY requirements.lock .
RUN pip install -r requirements.lock

COPY . .

CMD ["python", "run.py"]

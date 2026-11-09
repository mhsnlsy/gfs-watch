FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends libeccodes-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY detector.py grib2_analyze.py server.py ./
ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python","server.py"]
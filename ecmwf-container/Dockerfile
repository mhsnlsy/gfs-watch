FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg \
    ECMWF_PUBLIC_DIR=/tmp/public/ecmwf

WORKDIR /app

RUN pip install --no-cache-dir numpy matplotlib

COPY scripts/fetch_ecmwf_eps.py /app/scripts/fetch_ecmwf_eps.py
COPY scripts/render_ecmwf_report_charts.py /app/scripts/render_ecmwf_report_charts.py
COPY ecmwf-container/server.py /app/server.py

RUN mkdir -p /tmp/public/ecmwf

EXPOSE 8080

CMD ["python", "/app/server.py"]

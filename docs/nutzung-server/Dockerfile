FROM python:3.13-slim
WORKDIR /app
COPY server.py uebersicht.html ./
ENV PYTHONUNBUFFERED=1 PORT=8080 NUTZUNG_DB=/daten/nutzung.sqlite
EXPOSE 8080
HEALTHCHECK CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/gesund')"
CMD ["python", "server.py"]

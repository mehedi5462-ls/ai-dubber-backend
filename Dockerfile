FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential git cmake python3 python3-pip python3-venv \
    wget curl ca-certificates ffmpeg pkg-config libsndfile1 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs

WORKDIR /opt/app

RUN pip3 install --no-cache-dir TTS==0.13.1 || true

RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp /opt/whisper.cpp \
 && mkdir -p /opt/whisper.cpp/build \
 && cd /opt/whisper.cpp/build \
 && cmake -DCMAKE_BUILD_TYPE=Release .. \
 && make -j"$(nproc)" \
 && cp /opt/whisper.cpp/build/main /opt/whisper || true

COPY package.json /opt/app/package.json
RUN npm install --production

COPY server.js /opt/app/server.js
COPY docker-entrypoint.sh /opt/app/docker-entrypoint.sh
RUN chmod +x /opt/app/docker-entrypoint.sh

RUN mkdir -p /opt/app/models

EXPOSE 10000
ENV PORT=10000

ENTRYPOINT ["/opt/app/docker-entrypoint.sh"]
CMD ["node","/opt/app/server.js"]
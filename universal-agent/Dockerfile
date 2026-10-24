# Ofis web platform. The developer agent runs shell commands, so keep it in a
# container: it can only touch /workspace and /data inside this image.
FROM node:22-slim

# Tools the developer agent commonly needs when building projects.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public

RUN mkdir -p /data /workspace && chown node:node /data /workspace
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    WORKSPACE_DIR=/workspace
EXPOSE 3000
VOLUME ["/data", "/workspace"]
CMD ["node", "src/server.js"]

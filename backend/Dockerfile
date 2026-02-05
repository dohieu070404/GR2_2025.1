# SmartHome backend container
# Node.js/Express + Prisma + MySQL + MQTT

FROM node:20-bookworm-slim

# Prisma needs OpenSSL in slim images
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better Docker layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Prisma schema + migrations
COPY prisma ./prisma
RUN npx prisma generate

# App source
COPY src ./src

# Docker entrypoint
COPY docker ./docker
RUN chmod +x ./docker/entrypoint.sh

RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["./docker/entrypoint.sh"]

# Research Digest AI — standalone host image for Coolify (or any Docker host)
FROM node:20-alpine

WORKDIR /app

# Install the standalone host dependencies first (better layer caching).
# Only the host (server.js) needs deps; the Executa plugin uses Node builtins.
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

# Container-level health check (Coolify also reads /health)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]

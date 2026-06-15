# Research Digest AI — production image for Coolify (or any Docker host)
FROM node:20-alpine

WORKDIR /app

# Install the research-processor plugin dependencies first (better layer caching)
COPY executas/research-processor-node/package*.json ./executas/research-processor-node/
RUN cd executas/research-processor-node && npm install --omit=dev

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

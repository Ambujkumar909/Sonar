# Sonar — read-only WhatsApp intelligence platform
FROM node:22-bookworm-slim

WORKDIR /app

# install only production deps (pure-JS now — no native sqlite build needed)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# app source
COPY src ./src
COPY public ./public
COPY scripts/export-chats.js ./scripts/export-chats.js
COPY scripts/daily-report.js ./scripts/daily-report.js
COPY automate.js ./automate.js

ENV NODE_ENV=production
ENV PORT=4545
EXPOSE 4545

# .txt archives live here (mount a volume to persist/inspect them)
RUN mkdir -p /app/logs

CMD ["node", "src/server.js"]

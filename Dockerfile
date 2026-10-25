# Schmaps — all-Canadian mapping PWA
# Zero-dependency Node.js server; no build step required.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Copy only what the server needs at runtime.
COPY package.json ./
COPY server.js ./
COPY public ./public

# Run as the built-in non-root node user.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
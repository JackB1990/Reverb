FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY server.js ./
COPY public ./public

# /data holds the SQLite database. Owned by the unprivileged "node" user so a
# fresh named volume is writable without any extra setup.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080
VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]

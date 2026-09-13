# Quad API — production image.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# embedded-postgres is a devDependency used only by the test suite; omit=dev
# keeps the real PostgreSQL binaries (hundreds of MB) out of the image.
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Run unprivileged. The uploads directory is the only writable path, and in
# production STORAGE_PROVIDER should be s3 so even that is unused.
RUN addgroup -S quad && adduser -S quad -G quad
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=quad:quad package.json ./
COPY --chown=quad:quad src ./src
RUN mkdir -p /app/var/uploads && chown -R quad:quad /app/var

USER quad
EXPOSE 8080

# The readiness probe checks the database, not just the process. An instance
# that cannot reach Postgres is removed from the load balancer rather than
# left serving errors.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]

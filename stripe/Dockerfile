# --- Runtime-only build (small, fast) ---
FROM node:20-alpine

# System deps (none usually required, but libc6-compat is handy)
RUN apk add --no-cache libc6-compat

# App directory
WORKDIR /app

# Copy manifests first to leverage cache
COPY package.json package-lock.json* ./

# Install prod deps only; use ci when lockfile exists
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Copy source
COPY . .

# Security: create non-root user
RUN adduser -D -u 10001 stripeuser && chown -R stripeuser:stripeuser /app
USER stripeuser

# Environment
ENV NODE_ENV=production
# Respect your env var for port; default 8084 like in compose
ENV PORT=${STRIPE_WEBHOOK_PORT:-8084}

EXPOSE 8084

# Start the server
CMD ["node", "webhook/server.js"]
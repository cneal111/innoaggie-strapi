# --- Build stage (Debian, not Alpine) ---
FROM node:20-bookworm-slim AS build
ENV NODE_ENV=production
# build tools + libvips for sharp; python3 for native builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 git libvips \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/app

# lockfile-first install INSIDE the image (no host node_modules)
COPY package.json package-lock.json ./
RUN rm -rf node_modules && npm ci --include=dev --prefer-offline

# App source
COPY . .

# Force better-sqlite3 to be compiled for THIS image/arch
# (NPM v9 supports --build-from-source; also set env for safety)
ENV npm_config_build_from_source=true
RUN npm rebuild better-sqlite3 --build-from-source || true

# Build admin
RUN npm run build

# Trim dev deps for runtime
RUN npm prune --omit=dev

# --- Runtime stage ---
FROM node:20-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends libvips \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/app
COPY --from=build /opt/app ./

# Ensure persistent dirs exist & perms are sane
RUN mkdir -p ./public/uploads ./.tmp && \
    useradd -m -u 10001 strapi && chown -R strapi:strapi /opt/app
USER strapi

EXPOSE 1337
CMD ["npm", "run", "start"]
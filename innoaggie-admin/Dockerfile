# Creating multi-stage build for production
FROM node:22-alpine AS build
RUN apk update && apk add --no-cache build-base gcc autoconf automake zlib-dev libpng-dev vips-dev git > /dev/null 2>&1
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

WORKDIR /opt/
COPY package.json package-lock.json ./
RUN npm install -g node-gyp
RUN npm config set fetch-retry-maxtimeout 600000 -g && npm install --only=production
ENV PATH=/opt/node_modules/.bin:$PATH

WORKDIR /opt/app
COPY . .

# Ensure no host node_modules slipped in
RUN rm -rf /opt/app/node_modules

# (re)build native modules against THIS image's Node
RUN npm rebuild better-sqlite3

RUN npm run build

# Creating final production image
FROM node:22-alpine
RUN apk add --no-cache vips-dev
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

WORKDIR /opt/
COPY --from=build /opt/node_modules ./node_modules
ENV PATH=/opt/node_modules/.bin:$PATH

WORKDIR /opt/app
COPY --from=build /opt/app ./

# create dirs and chown (build-time)
RUN mkdir -p /opt/app/.tmp /opt/app/public/uploads && chown -R node:node /opt/app

# minimal runtime fix so mounted volumes are writable
USER root

# write entrypoint safely (no escaping issues)
RUN cat > /entrypoint.sh <<'SH'
#!/bin/sh
set -e
mkdir -p /opt/app/.tmp /opt/app/public/uploads
chown -R node:node /opt/app/.tmp /opt/app/public/uploads || true
exec "$@"
SH
RUN chmod +x /entrypoint.sh

USER node
ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm","run","start"]
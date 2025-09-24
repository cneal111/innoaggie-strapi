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
RUN npm run build

# Creating final production image
FROM node:22-alpine
RUN apk add --no-cache vips-dev
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
WORKDIR /opt/
COPY --from=build /opt/node_modules ./node_modules
WORKDIR /opt/app
COPY --from=build /opt/app ./
ENV PATH=/opt/node_modules/.bin:$PATH

# (unchanged) create dirs and chown inside image
RUN mkdir -p /opt/app/.tmp /opt/app/public/uploads && chown -R node:node /opt/app

# --- minimal addition: tiny entrypoint to fix perms on mounted volumes ---
USER root
# write a 5-line script that runs at container start (after volumes are mounted)
RUN printf '#!/bin/sh\nset -e\nmkdir -p /opt/app/.tmp /opt/app/public/uploads\nchown -R node:node /opt/app/.tmp /opt/app/public/uploads || true\nexec "$@"\n' > /entrypoint.sh \
 && chmod +x /entrypoint.sh
USER node
ENTRYPOINT ["/entrypoint.sh"]
# --- end minimal addition ---

EXPOSE 1337
CMD ["npm", "run", "start"]
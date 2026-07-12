FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.service.json ./
RUN npm ci
COPY src ./src
RUN npx tsc -p tsconfig.service.json

FROM node:22-bookworm-slim AS runtime

ARG VERSION=development
ARG REVISION=unknown
ARG CREATED=unknown

LABEL org.opencontainers.image.title="Scientific Protocol reference service" \
      org.opencontainers.image.description="Versioned gateway, indexer, migration, and worker runtime" \
      org.opencontainers.image.source="https://github.com/emgun/scientific-protocol" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.created=$CREATED

ENV NODE_ENV=production \
    PORT=3000 \
    SP_ARTIFACT_BACKEND=filesystem \
    SP_ARTIFACT_FILESYSTEM_ROOT=/var/lib/scientific-protocol/artifacts \
    SP_RUN_MIGRATIONS=false \
    SP_SERVICE_BUILD_DATE=$CREATED \
    SP_SERVICE_MODE=read-only \
    SP_SERVICE_REVISION=$REVISION \
    SP_SERVICE_VERSION=$VERSION

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY ops/migrations ./ops/migrations
COPY schemas ./schemas
RUN mkdir -p /var/lib/scientific-protocol/artifacts && chown -R node:node /var/lib/scientific-protocol

USER node
EXPOSE 3000
ENTRYPOINT ["node", "dist/service/cli.js"]
CMD ["gateway"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "dist/service/cli.js", "healthcheck"]

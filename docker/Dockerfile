# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @wardenhq/server deploy --prod --legacy /out \
  && cp -r apps/web/dist /out/web

FROM node:22-alpine
# Set by the release workflow from the tag; reported by /healthz and logged at startup.
ARG WARDEN_VERSION=dev
ENV NODE_ENV=production \
    WARDEN_VERSION=$WARDEN_VERSION \
    PORT=3000 \
    WARDEN_WEB_DIR=/app/web
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "dist/index.js"]

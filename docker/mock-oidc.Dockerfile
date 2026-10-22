# syntax=docker/dockerfile:1
# Mock OIDC provider for local development and E2E. Never deploy this.

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @wardenhq/mock-oidc
RUN pnpm --filter @wardenhq/mock-oidc build
RUN pnpm --filter @wardenhq/mock-oidc deploy --prod --legacy /out

FROM node:22-alpine
LABEL org.opencontainers.image.title="Warden mock OIDC (development only)" \
      org.opencontainers.image.description="Development-only OIDC provider that signs anyone in as a fixed test user, with no password. For trying Warden locally and E2E tests. Never deploy it."
ENV NODE_ENV=production \
    MOCK_OIDC_PORT=9400
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 9400
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD wget -qO- http://127.0.0.1:${MOCK_OIDC_PORT}/.well-known/openid-configuration || exit 1
CMD ["node", "dist/main.js"]

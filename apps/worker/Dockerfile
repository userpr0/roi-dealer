# ROI Dealer worker — production image (PHASE 05: evidence collection).
#
# Build from the repository root:
#   docker build -f apps/worker/Dockerfile --build-arg APP_VERSION=$(git rev-parse --short HEAD) -t roi-dealer-worker .
# Run (secrets come from the environment, never from the image):
#   docker run -d --restart unless-stopped --env-file worker.env roi-dealer-worker
# Apply database migrations before a new version starts (Railway: Pre-deploy Command). Running it
# from the bot and the worker at the same time is safe: the runner takes a lock.
#   docker run --rm --env-file worker.env roi-dealer-worker node node_modules/@roi-dealer/database/dist/migrate-cli.js

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm exec tsc -b apps/worker \
 && pnpm --filter @roi-dealer/worker deploy --prod --legacy /out

FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    DATABASE_MIGRATIONS_DIR=/app/database/migrations
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /repo/database/migrations ./database/migrations
USER node
CMD ["node", "--enable-source-maps", "dist/main.js"]

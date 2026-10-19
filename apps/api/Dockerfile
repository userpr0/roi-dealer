# ROI Dealer API — production image: /health and the Mini App panel (PHASE 13, ADR-0008).
#
# Build from the repository root:
#   docker build -f apps/api/Dockerfile --build-arg APP_VERSION=$(git rev-parse --short HEAD) -t roi-dealer-api .
# Run (secrets come from the environment, never from the image):
#   docker run -d --restart unless-stopped -p 8080:8080 --env-file api.env roi-dealer-api
# The api only reads the database; migrations are applied by the bot and the worker (Pre-deploy).

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm exec tsc -b apps/api \
 && pnpm --filter @roi-dealer/api deploy --prod --legacy /out

FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    API_HOST=0.0.0.0 \
    API_PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/main.js"]

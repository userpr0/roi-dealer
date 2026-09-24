# ROI Dealer owner bot — production image (ADR-0003).
#
# Build from the repository root:
#   docker build -f apps/bot/Dockerfile --build-arg APP_VERSION=$(git rev-parse --short HEAD) -t roi-dealer-bot .
# Run (secrets come from the environment, never from the image):
#   docker run -d --restart unless-stopped --env-file bot.env roi-dealer-bot

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm exec tsc -b apps/bot \
 && pnpm --filter @roi-dealer/bot deploy --prod --legacy /out

FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM node:22.22.0-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22.22.0-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    QUEUE_CONTEXT_PYTHON=/usr/bin/python3

COPY --from=build /app ./

EXPOSE 10000
CMD ["node", "scripts/start-production.mjs"]

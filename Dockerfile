FROM node:24-alpine3.24 AS build
WORKDIR /app
RUN apk upgrade --no-cache \
  && corepack enable \
  && corepack prepare pnpm@10.0.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/dashboard/package.json packages/dashboard/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
RUN mkdir -p packages/dashboard/public
RUN pnpm install --frozen-lockfile
COPY . .
RUN if find /app -type f -name '.env*' -print -quit | grep -q .; then echo 'dotenv files must not enter the image build context'; exit 1; fi
RUN pnpm build

FROM node:24-alpine3.24 AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk upgrade --no-cache \
  && corepack enable \
  && corepack prepare pnpm@10.0.0 --activate \
  && mkdir -p /mochi-data \
  && chown -R node:node /app /mochi-data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/mcp-server/package.json ./packages/mcp-server/package.json
COPY --from=build --chown=node:node /app/packages/mcp-server/node_modules ./packages/mcp-server/node_modules
COPY --from=build --chown=node:node /app/packages/mcp-server/dist ./packages/mcp-server/dist
COPY --from=build --chown=node:node /app/packages/dashboard/package.json ./packages/dashboard/package.json
COPY --from=build --chown=node:node /app/packages/dashboard/node_modules ./packages/dashboard/node_modules
COPY --from=build --chown=node:node /app/packages/dashboard/next.config.js ./packages/dashboard/next.config.js
COPY --from=build --chown=node:node /app/packages/dashboard/.next ./packages/dashboard/.next
COPY --from=build --chown=node:node /app/packages/dashboard/public ./packages/dashboard/public
COPY --chown=node:node deploy/start.mjs ./deploy/start.mjs
USER node
EXPOSE 3001 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3002/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/app/deploy/start.mjs"]

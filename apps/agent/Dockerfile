# Build context is the WORKSPACE ROOT, not this directory — a workspace package cannot be built in
# isolation because the lockfile lives at the root. From the repo root:
#   docker build -f apps/agent/Dockerfile -t sarati/agent .
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/agent/package.json apps/agent/
RUN pnpm install --frozen-lockfile --filter @sarati/agent
COPY apps/agent apps/agent
RUN pnpm --filter @sarati/agent build
# Resolves the workspace package into a self-contained tree — no workspace, no symlinks, prod deps
# only. `--legacy` because no package here injects another; nothing depends on a sibling.
RUN pnpm deploy --legacy --filter @sarati/agent --prod /out
# deploy honours ignore rules and `dist/` is gitignored, so the build output has to come across itself.
RUN rm -rf /out/src && cp -r apps/agent/dist /out/dist

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=8010
RUN apk add --no-cache tini
WORKDIR /app

COPY --from=build --chown=node:node /out ./

USER node
EXPOSE 8010

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8010)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

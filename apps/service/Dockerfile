# Build context is the WORKSPACE ROOT, not this directory — a workspace package cannot be built in
# isolation because the lockfile lives at the root. From the repo root:
#   docker build -f apps/service/Dockerfile -t sarati/service .
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/service/package.json apps/service/
# The bridge is a workspace member, so its manifest must exist for --frozen-lockfile to match.
COPY apps/service/packages/mcp-bridge/package.json apps/service/packages/mcp-bridge/
RUN pnpm install --frozen-lockfile --filter @sarati/service
COPY apps/service apps/service
RUN pnpm --filter @sarati/service build
# Resolves the workspace package into a self-contained tree — no workspace, no symlinks, prod deps
# only. `--legacy` because no package here injects another; nothing depends on a sibling.
RUN pnpm deploy --legacy --filter @sarati/service --prod /out
# deploy honours ignore rules and `dist/` is gitignored, so the build output has to come across itself.
RUN rm -rf /out/src /out/test && cp -r apps/service/dist /out/dist

# Deliberately NOT the pnpm base: corepack would re-resolve and download pnpm on first use, making an
# offline container unable to run its own recovery command. Everything here runs on plain node.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production ENVIRONMENT=production PORT=8001
RUN apk add --no-cache tini
WORKDIR /app

# --chown on the COPY, never a recursive chown after it: rewriting ownership in a later layer
# duplicates every file it touches (node_modules alone cost ~287MB as a second copy).
COPY --from=build --chown=node:node /out ./
COPY apps/service/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY apps/service/docker/sarati-set-password /usr/local/bin/sarati-set-password
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/sarati-set-password

# Secrets are generated on first boot and persisted here, so the volume must outlive the container.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8001

HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8001)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/main.js"]

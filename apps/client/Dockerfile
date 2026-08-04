# Build context is the WORKSPACE ROOT, not this directory — a workspace package cannot be built in
# isolation because the lockfile lives at the root. From the repo root:
#   docker build -f apps/client/Dockerfile -t sarati/client .
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/client/package.json apps/client/
RUN pnpm install --frozen-lockfile --filter @sarati/client
COPY apps/client apps/client
# NEXT_PUBLIC_* are inlined by `next build`, so a published image must not bake in a host — it would
# freeze every install to whatever machine built it. `same-origin` makes the calls relative and lets
# whatever sits in front decide where they land; override per-build for a fixed deployment.
ARG NEXT_PUBLIC_API_URL=same-origin
ARG NEXT_PUBLIC_AGENT_URL=same-origin
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_AGENT_URL=$NEXT_PUBLIC_AGENT_URL \
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @sarati/client build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache tini
WORKDIR /app

# Next's standalone output mirrors the workspace layout, so the server lands at
# `apps/client/server.js` with the hoisted node_modules beside it at the tree root.
COPY --from=build --chown=node:node /repo/apps/client/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/client/.next/static ./apps/client/.next/static
COPY --from=build --chown=node:node /repo/apps/client/public ./apps/client/public

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/client/server.js"]

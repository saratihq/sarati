# syntax=docker/dockerfile:1
# The whole product in one container: `docker run -p 8080:8080 sarati/sarati`.
#
# Assembled FROM the per-service images rather than rebuilt, so what runs here is byte-identical to
# what the release already verified — there is no second build to drift.
ARG VERSION=latest
ARG REGISTRY=ghcr.io/saratihq
FROM ${REGISTRY}/sarati-service:${VERSION} AS service
FROM ${REGISTRY}/sarati-agent:${VERSION} AS agent
FROM ${REGISTRY}/sarati-client:${VERSION} AS client

FROM node:24-alpine
# No global PORT: each service sets its own in supervisord, exactly as its own image does.
# Setting one here leaked 8001 into the agent and the two fought over the port.
ENV NODE_ENV=production \
    PGDATA=/data/postgres \
    SARATI_SERVICE_DIR=/opt/sarati/service \
    PATH=/usr/libexec/postgresql16:$PATH

# Real Postgres, not an embedded stand-in: the engine runs two processes against one database and
# needs pg-boss and DBOS, none of which survive a single-connection database.
# -contrib carries uuid-ossp, which the schema creates; without it every boot dies on migrate.
RUN apk add --no-cache postgresql16 postgresql16-contrib postgresql16-client caddy supervisor tini su-exec \
 && mkdir -p /run/postgresql /data \
 && chown postgres:postgres /run/postgresql

COPY --from=service /app /opt/sarati/service
COPY --from=agent /app /opt/sarati/agent
COPY --from=client /app /opt/sarati/client
COPY --from=service /usr/local/bin/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --from=service /usr/local/bin/sarati-set-password /usr/local/bin/sarati-set-password

COPY docker/all-in-one/Caddyfile /etc/caddy/Caddyfile
COPY docker/all-in-one/supervisord.conf /etc/supervisord.conf
COPY docker/all-in-one/boot.sh /usr/local/bin/boot.sh
RUN chmod +x /usr/local/bin/boot.sh /usr/local/bin/entrypoint.sh /usr/local/bin/sarati-set-password

# Everything that must outlive the container: the database, and the keys that decrypt credentials.
VOLUME /data
EXPOSE 8080

# The proxy is the product's only door, so its readiness is the container's.
HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/boot.sh"]

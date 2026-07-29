ARG NODE_IMAGE=node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

FROM ${NODE_IMAGE} AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /workspace

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/brace-expansion@5.0.8.patch patches/brace-expansion@5.0.8.patch
COPY tsconfig.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps apps
COPY packages packages
COPY scripts/admin/generate-project-config.mjs scripts/admin/generate-project-config.mjs
COPY scripts/admin/validate-project-config.mjs scripts/admin/validate-project-config.mjs
COPY LICENSE LICENSE

RUN pnpm install --frozen-lockfile

RUN sqlite_dir=/workspace/node_modules/.pnpm/better-sqlite3@13.0.1/node_modules/better-sqlite3 \
  && rm -rf "${sqlite_dir}/prebuilds" "${sqlite_dir}/build" \
  && cd "${sqlite_dir}" \
  && /workspace/node_modules/.bin/node-gyp rebuild --release --force_build=1 --nodedir=/usr/local

RUN pnpm build \
  && pnpm --filter @sentrybox/server deploy --legacy --prod /opt/sentrybox \
  && rm -rf /opt/sentrybox/node_modules/.pnpm/better-sqlite3@13.0.1/node_modules/better-sqlite3/prebuilds \
    /opt/sentrybox/node_modules/.pnpm/better-sqlite3@13.0.1/node_modules/better-sqlite3/build \
  && mkdir -p /opt/sentrybox/node_modules/.pnpm/better-sqlite3@13.0.1/node_modules/better-sqlite3/build/Release \
  && install -m 0555 \
    /workspace/node_modules/.pnpm/better-sqlite3@13.0.1/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
    /opt/sentrybox/node_modules/.pnpm/better-sqlite3@13.0.1/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  && rm -rf /opt/sentrybox/src /opt/sentrybox/test /opt/sentrybox/dist/test \
    /opt/sentrybox/tsconfig.json \
  && find /opt/sentrybox/dist -type f \( \
    -name "*.test.js" -o -name "*.test.d.ts" -o -name "*.test.d.ts.map" \
    -o -name "*.d.ts" -o -name "*.d.ts.map" -o -name "*.js.map" \
    -o -name "tsconfig.tsbuildinfo" \) -delete \
  && for package_dir in /opt/sentrybox/node_modules/.pnpm/@sentrybox+*/node_modules/@sentrybox/*; do \
    rm -rf "${package_dir}/src" "${package_dir}/test" "${package_dir}/tsconfig.json"; \
    find "${package_dir}/dist" -type f \( \
      -name "*.test.js" -o -name "*.d.ts" -o -name "*.d.ts.map" \
      -o -name "*.js.map" -o -name "tsconfig.tsbuildinfo" \) -delete; \
  done \
  && mkdir -p /opt/sentrybox/scripts/admin \
  && install -m 0444 \
    /workspace/scripts/admin/generate-project-config.mjs \
    /workspace/scripts/admin/validate-project-config.mjs \
    /opt/sentrybox/scripts/admin/ \
  && cp /workspace/LICENSE /opt/sentrybox/LICENSE

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /opt/yarn-v1.22.22 \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm \
    /usr/local/bin/pnpx \
  && mkdir /data \
  && mkdir -p /run/config \
  && chown 1000:1000 /data /run/config

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder --chown=1000:1000 /opt/sentrybox/ ./

USER 1000:1000
EXPOSE 8080 8081

CMD ["node", "dist/src/main.js"]

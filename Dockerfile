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
COPY tsconfig.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/protocol/package.json packages/protocol/package.json

RUN pnpm install --frozen-lockfile

RUN sqlite_dir=/workspace/node_modules/.pnpm/better-sqlite3@13.0.1/node_modules/better-sqlite3 \
  && rm -rf "${sqlite_dir}/prebuilds" "${sqlite_dir}/build" \
  && cd "${sqlite_dir}" \
  && /workspace/node_modules/.bin/node-gyp rebuild --release --force_build=1 --nodedir=/usr/local

COPY apps apps
COPY packages packages
COPY LICENSE LICENSE

RUN pnpm build \
  && pnpm --filter @intexura-error-hub/server deploy --legacy --prod /opt/error-hub \
  && rm -rf /opt/error-hub/node_modules/.pnpm/better-sqlite3@13.0.1/node_modules/better-sqlite3/prebuilds \
    /opt/error-hub/node_modules/.pnpm/better-sqlite3@13.0.1/node_modules/better-sqlite3/build \
  && mkdir -p /opt/error-hub/node_modules/.pnpm/better-sqlite3@13.0.1/node_modules/better-sqlite3/build/Release \
  && install -m 0555 \
    /workspace/node_modules/.pnpm/better-sqlite3@13.0.1/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
    /opt/error-hub/node_modules/.pnpm/better-sqlite3@13.0.1/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  && rm -rf /opt/error-hub/src /opt/error-hub/test /opt/error-hub/dist/test \
    /opt/error-hub/tsconfig.json \
  && find /opt/error-hub/dist -type f \( \
    -name "*.test.js" -o -name "*.test.d.ts" -o -name "*.test.d.ts.map" \
    -o -name "*.d.ts" -o -name "*.d.ts.map" -o -name "*.js.map" \
    -o -name "tsconfig.tsbuildinfo" \) -delete \
  && for package_dir in /opt/error-hub/node_modules/.pnpm/@intexura-error-hub+*/node_modules/@intexura-error-hub/*; do \
    rm -rf "${package_dir}/src" "${package_dir}/test" "${package_dir}/tsconfig.json"; \
    find "${package_dir}/dist" -type f \( \
      -name "*.test.js" -o -name "*.d.ts" -o -name "*.d.ts.map" \
      -o -name "*.js.map" -o -name "tsconfig.tsbuildinfo" \) -delete; \
  done \
  && cp /workspace/LICENSE /opt/error-hub/LICENSE

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN mkdir /data && chown 1000:1000 /data

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder --chown=1000:1000 /opt/error-hub/ ./

USER 1000:1000
EXPOSE 8080 8081

CMD ["node", "dist/src/main.js"]

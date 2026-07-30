import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const DEFAULT_HOME_DEV = "https://home-dev.taild6ad57.ts.net:8443";

function readOnlyApiProxy(enabled: boolean): Plugin {
  return {
    name: "sentrybox-read-only-api-proxy",
    configureServer(server) {
      if (!enabled) return;
      server.middlewares.use((request, response, next) => {
        const isApiRequest =
          request.url === "/api" || request.url?.startsWith("/api/") === true;
        const isRead = request.method === "GET" || request.method === "HEAD";
        if (!isApiRequest || isRead) {
          next();
          return;
        }
        response.statusCode = 405;
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            error: {
              message: "Mutations are disabled by the local development proxy.",
            },
          }),
        );
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.SENTRYBOX_DEV_API_TARGET ?? DEFAULT_HOME_DEV;
  const allowMutations = env.VITE_SENTRYBOX_ALLOW_MUTATIONS === "1";
  return {
    plugins: [readOnlyApiProxy(!allowMutations), react()],
    server: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          secure: true,
          configure(proxy) {
            proxy.on("proxyReq", (request) => {
              // Read-only local requests must not inherit localhost as their
              // origin when the private deployment validates browser origins.
              request.removeHeader("origin");
            });
          },
        },
      },
    },
  };
});

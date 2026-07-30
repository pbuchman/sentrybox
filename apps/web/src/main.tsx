import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import {
  createApiClient,
  createReadOnlyApi,
  type OperatorApi,
} from "./api/client.js";

const root = document.getElementById("root");
if (root === null) throw new Error("SentryBox root element is missing");

void apiForEnvironment().then(({ api, readOnly }) => {
  createRoot(root).render(<App api={api} readOnly={readOnly} />);
});

async function apiForEnvironment(): Promise<{
  readonly api: OperatorApi;
  readonly readOnly: boolean;
}> {
  if (import.meta.env.VITE_SENTRYBOX_FIXTURES === "1") {
    const { createFixtureApi } = await import("./api/fixture-api.js");
    return { api: createFixtureApi(), readOnly: false };
  }
  const api = createApiClient();
  const readOnly =
    import.meta.env.DEV &&
    import.meta.env.VITE_SENTRYBOX_ALLOW_MUTATIONS !== "1";
  return { api: readOnly ? createReadOnlyApi(api) : api, readOnly };
}

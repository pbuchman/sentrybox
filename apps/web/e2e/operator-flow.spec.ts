import {
  expect,
  test,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";

const occurredAt = "2026-07-29T11:58:00.000Z";
const listIssue = {
  id: 41,
  project: { id: "1", slug: "intexuraos-backend", name: "IntexuraOS backend" },
  title: "TypeError: Cannot read properties of undefined",
  status: "unresolved",
  generation: 1,
  count: 143,
  occurrenceCount: 143,
  matchingCount: 18,
  firstSeen: "2026-07-29T08:00:00.000Z",
  lastSeen: occurredAt,
  lastReceivedAt: "2026-07-29T11:58:01.000Z",
  highestLevel: "error",
  resolvedAt: null,
  createdAt: "2026-07-29T08:00:01.000Z",
  updatedAt: "2026-07-29T11:58:01.000Z",
};
const facets = {
  project: [
    {
      value: "intexuraos-backend",
      queryValue: "intexuraos-backend",
      label: "IntexuraOS backend",
      count: 143,
    },
  ],
  release: [
    { value: null, queryValue: "~v1:n", label: "Unknown version", count: 2 },
    {
      value: "2026.07.29-a",
      queryValue: "~v1:s:MjAyNi4wNy4yOS1h",
      label: "2026.07.29-a",
      count: 141,
    },
  ],
  environment: [
    { value: "prod", queryValue: "prod", label: "prod", count: 120 },
  ],
  service: [
    {
      value: "whatsapp-service",
      queryValue: "~v1:s:d2hhdHNhcHAtc2VydmljZQ",
      label: "whatsapp-service",
      count: 143,
    },
  ],
  level: [{ value: "error", queryValue: "error", label: "error", count: 143 }],
  status: [
    {
      value: "unresolved",
      queryValue: "unresolved",
      label: "unresolved",
      count: 143,
    },
    {
      value: "resolved",
      queryValue: "resolved",
      label: "resolved",
      count: 1,
    },
  ],
};
const eventSummary = {
  id: "event-sdk-id",
  rowId: 501,
  issueId: 41,
  projectId: 1,
  projectSlug: "intexuraos-backend",
  issueGeneration: 1,
  environment: "prod",
  release: null,
  service: "whatsapp-service",
  level: "error",
  platform: "node",
  title: listIssue.title,
  message: "Cannot read value",
  exceptionType: "TypeError",
  culprit: "handleMessage",
  occurredAt,
  receivedAt: "2026-07-29T11:58:01.000Z",
  requestId: "request-42",
  traceId: null,
  taskId: null,
  truncated: false,
};
const issueDetail = {
  ...listIssue,
  count: 2,
  occurrenceCount: 2,
  matchingCount: undefined,
  facets: {
    environment: [
      {
        value: "prod",
        queryValue: "prod",
        label: "prod",
        count: 2,
        lastSeen: occurredAt,
      },
    ],
    release: [
      {
        value: null,
        queryValue: "~v1:n",
        label: "Unknown version",
        count: 1,
        lastSeen: occurredAt,
      },
    ],
    service: [
      {
        value: "whatsapp-service",
        queryValue: "~v1:s:d2hhdHNhcHAtc2VydmljZQ",
        label: "whatsapp-service",
        count: 2,
        lastSeen: occurredAt,
      },
    ],
    level: [
      {
        value: "error",
        queryValue: "error",
        label: "error",
        count: 2,
        lastSeen: occurredAt,
      },
    ],
  },
  deliveries: [
    {
      id: 77,
      deliveryId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      cause: "created",
      state: "dead_letter",
      attempts: 1,
      nextAttempt: null,
      lastError: "Code Agent returned 403",
      createdAt: "2026-07-29T08:00:01.000Z",
      deliveredAt: null,
      redrives: [],
    },
  ],
};
const eventDetail = {
  ...eventSummary,
  id: 501,
  eventId: "event-sdk-id",
  logLocator: {
    confidence: "exact_identifier",
    query:
      '{environment="prod",service="whatsapp-service"} |~ "(^|[|[:space:]])requestId=request-42([|[:space:]]|$)|\\"requestId\\":\\"request-42\\""',
    grafanaUrl: "https://grafana.example/explore?query=request-42",
    from: "2026-07-29T11:56:00.000Z",
    to: "2026-07-29T12:00:00.000Z",
    criteria: {
      environment: "prod",
      service: "whatsapp-service",
      identifier: { kind: "requestId", value: "request-42" },
      message: null,
    },
    explanation:
      "Searches the event time window using the requestId correlation identifier.",
  },
  normalized: {
    id: "event-sdk-id",
    occurredAt,
    receivedAt: "2026-07-29T11:58:01.000Z",
    level: "error",
    title: listIssue.title,
    message: "Cannot read value",
    exception: {
      type: "TypeError",
      value: "Cannot read properties of undefined",
      mechanism: { handled: true },
      frames: [
        {
          filename: "node_modules/fastify/lib/handleRequest.js",
          function: "handleRequest",
          lineno: 100,
          in_app: false,
        },
        {
          filename: "apps/whatsapp/src/handle-message.ts",
          function: "handleMessage",
          lineno: 42,
          in_app: true,
        },
      ],
      discardedValues: 0,
    },
    breadcrumbs: [
      {
        timestamp: "2026-07-29T11:57:58.000Z",
        category: "request",
        message: "POST /messages",
        level: "info",
      },
    ],
    tags: { region: "home-dev" },
    release: null,
    environment: "prod",
    serverName: "whatsapp-service",
    platform: "node",
    logger: "whatsapp",
    requestId: "request-42",
    traceId: null,
    taskId: null,
    payload: {
      contexts: { runtime: { name: "node", version: "22.13.0" } },
      extras: { operation: "deliver message", authorization: "[REDACTED]" },
      correlations: { requestId: "request-42" },
    },
    payloadBytes: 2048,
    truncated: false,
    truncationReasons: [],
  },
};

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installPrivateApi(page: Page): Promise<void> {
  let status = "unresolved";
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (path === "/api/system/status") {
        return json(route, {
          status: "ok",
          storage: {
            physicalBytes: 1_932_735_283,
            budgetBytes: 5_368_709_120,
          },
          ingest: { accepting: true },
          outbox: { deadLetter: 1 },
        });
      }
      if (path === "/api/facets") return json(route, facets);
      if (path === "/api/issues" && request.method() === "GET") {
        return json(route, {
          items: [{ ...listIssue, status }],
          nextCursor: null,
          facets,
        });
      }
      if (path === "/api/issues/41/events") {
        return json(route, { items: [eventSummary], nextCursor: null });
      }
      if (path === "/api/events/501") return json(route, eventDetail);
      if (path === "/api/issues/41/resolve") {
        await expectJsonMutation(request);
        status = "resolved";
        return json(route, { ...issueDetail, status });
      }
      if (path === "/api/issues/41/reopen") {
        await expectJsonMutation(request);
        status = "unresolved";
        return json(route, { ...issueDetail, status });
      }
      if (path === "/api/webhook-deliveries/77/retry") {
        await expectJsonMutation(request);
        return json(
          route,
          {
            id: 88,
            deliveryId: "22222222-2222-4222-8222-222222222222",
            originalOutboxId: 77,
            state: "pending",
            attempts: 0,
            requestedAt: "2026-07-29T12:00:00.000Z",
            attemptedAt: null,
            lastError: null,
          },
          202,
        );
      }
      if (path === "/api/issues/41" && request.method() === "DELETE") {
        await expectPrivateRequest(request);
        expect(request.headers()["content-type"]).toBe("application/json");
        expect(request.postData()).toBe("{}");
        return route.fulfill({ status: 204 });
      }
      if (path === "/api/issues/41") {
        return json(route, { ...issueDetail, status });
      }
      return json(
        route,
        { error: { code: "not_found", message: "Not found" } },
        404,
      );
    },
  );
}

async function expectPrivateRequest(request: Request): Promise<void> {
  const headers = await request.allHeaders();
  expect(new URL(request.url()).host).toBe("127.0.0.1:4173");
  expect(headers["origin"]).toBe("http://127.0.0.1:4173");
}

async function expectJsonMutation(request: Request): Promise<void> {
  await expectPrivateRequest(request);
  expect(request.headers()["content-type"]).toBe("application/json");
  expect(request.postData()).toBe("{}");
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

async function expectReadableContrast(
  page: Page,
  selector: string,
): Promise<void> {
  const ratio = await page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const parse = (value: string): readonly number[] =>
        value
          .match(/\d+(?:\.\d+)?/gu)
          ?.slice(0, 3)
          .map(Number) ?? [];
      const luminance = (rgb: readonly number[]): number => {
        const channels = rgb.map((value) => {
          const normalized = (value ?? 0) / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return (
          0.2126 * (channels[0] ?? 0) +
          0.7152 * (channels[1] ?? 0) +
          0.0722 * (channels[2] ?? 0)
        );
      };
      const style = getComputedStyle(element);
      const foreground = luminance(parse(style.color));
      const background = luminance([255, 255, 255]);
      return (background + 0.05) / (foreground + 0.05);
    });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
}

test("desktop operator combines filters, inspects evidence, and recovers actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installPrivateApi(page);
  await page.goto("/");

  await expect(page.getByRole("table", { name: "Issues" })).toBeVisible();
  await expect(page.getByText("Shown 1 · Unresolved shown 1")).toBeVisible();
  await expect(page.getByText("Storage 1.8 / 5 GiB")).toBeVisible();
  await expectReadableContrast(page, ".issue-title");
  await expectReadableContrast(page, ".issue-facets");
  expect(
    await page
      .locator("time")
      .evaluateAll((times) =>
        times.every(
          (time) =>
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
              time.getAttribute("datetime") ?? "",
            ) &&
            time.textContent?.includes("UTC") === true &&
            /ago|just now|in \d/u.test(time.textContent),
        ),
      ),
  ).toBe(true);
  await page.getByLabel("Project").selectOption("intexuraos-backend");
  await page.getByLabel("Version").selectOption(["~v1:n"]);
  await page.getByLabel("Environment").selectOption(["prod"]);
  await page
    .getByLabel("Service")
    .selectOption(["~v1:s:d2hhdHNhcHAtc2VydmljZQ"]);
  await page.getByLabel("Level").selectOption(["error"]);
  await page.getByLabel("Search").fill("undefined");
  await page.getByLabel("From (UTC)").fill("2026-07-28T08:30");
  await page.getByLabel("To (UTC)").fill("2026-07-29T12:00");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(
    /project=intexuraos-backend.*release=%7Ev1%3An.*environment=prod.*service=%7Ev1%3As%3Ad2hhdHNhcHAtc2VydmljZQ.*level=error.*query=undefined.*from=2026-07-28T08%3A30%3A00.000Z.*to=2026-07-29T12%3A00%3A00.000Z/,
  );

  await page.getByRole("link", { name: listIssue.title }).click();
  await expect(
    page.getByRole("heading", { name: "Exception and application frames" }),
  ).toBeVisible();
  await expect(page.getByText("Exact identifier")).toBeVisible();
  await expect(page.getByText("Dead letter")).toBeVisible();
  await page.getByRole("button", { name: "Retry delivery" }).click();
  await expect(page.getByText("Redrive queued.")).toBeVisible();
  await page.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByText("Issue resolved.")).toBeVisible();
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByText("Issue reopened.")).toBeVisible();
  await expectNoDocumentOverflow(page);
});

test("webhook event permalink opens the exact retained occurrence", async ({
  page,
}) => {
  await installPrivateApi(page);
  await page.goto("/organizations/intexuraos/issues/41/events/event-sdk-id/");

  await expect(
    page.getByRole("heading", { name: "Exception and application frames" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Occurrences" })
      .getByRole("button")
      .first(),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await page
    .getByRole("dialog", { name: "Delete issue permanently?" })
    .getByRole("button", { name: "Delete 2 events permanently" })
    .click();
  await expect(page).toHaveURL("http://127.0.0.1:4173/?status=unresolved");
});

test("390px mobile uses an accessible filter sheet and article cards without page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installPrivateApi(page);
  await page.goto("/");

  await expect(page.getByRole("table", { name: "Issues" })).toBeHidden();
  await expect(
    page.getByRole("article", { name: listIssue.title }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open filters" }).click();
  const sheet = page.getByRole("dialog", { name: "Filter issues" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("Project")).toBeVisible();
  await expect(sheet.getByLabel("Project")).toBeFocused();
  await sheet.getByLabel("Project").press("Shift+Tab");
  await expect(
    sheet.getByRole("button", { name: "Close filters" }),
  ).toBeFocused();
  await sheet.getByRole("button", { name: "Close filters" }).press("Shift+Tab");
  await expect(sheet.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(
    await sheet
      .getByRole("button", { name: "Apply filters" })
      .evaluate((button) =>
        Number.parseFloat(getComputedStyle(button).transitionDuration),
      ),
  ).toBeLessThanOrEqual(0.001);
  await sheet.getByLabel("Environment").selectOption(["prod"]);
  await sheet.getByRole("button", { name: "Apply filters" }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/environment=prod/);
  await expectNoDocumentOverflow(page);

  await page.getByRole("link", { name: listIssue.title }).click();
  await expect(page.getByRole("button", { name: "Resolve" })).toBeVisible();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Delete issue permanently?",
  });
  await expect(dialog.getByText(/This removes 2 events/)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).press("Enter");
  await expect(dialog).toBeHidden();
  await expectNoDocumentOverflow(page);
});

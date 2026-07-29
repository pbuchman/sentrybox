import assert from "node:assert/strict";
import test from "node:test";

import { listCodeAgentTasks } from "./verify-code-agent-flow.mjs";

const RUNTIME = {
  codeAgentBaseUrl: "https://dev.intexuraos.cloud/api/code",
  authToken: "test-token",
};

test("lists all Code Agent tasks when the account requires 45 pages", async () => {
  const pageCount = 45;
  let requests = 0;
  const fetchImpl = async (url) => {
    const page = requests;
    requests += 1;
    assert.equal(
      new URL(url).searchParams.get("cursor"),
      page === 0 ? null : `cursor-${String(page)}`,
    );
    return jsonResponse({
      success: true,
      data: {
        tasks: [{ id: `task-${String(page)}` }],
        ...(page + 1 < pageCount
          ? { nextCursor: `cursor-${String(page + 1)}` }
          : {}),
      },
    });
  };

  const tasks = await listCodeAgentTasks(fetchImpl, RUNTIME);

  assert.equal(requests, pageCount);
  assert.equal(tasks.length, pageCount);
});

test("rejects a repeated Code Agent pagination cursor", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return jsonResponse({
      success: true,
      data: {
        tasks: [],
        nextCursor: "repeated-cursor",
      },
    });
  };

  await assert.rejects(
    listCodeAgentTasks(fetchImpl, RUNTIME),
    /repeated Code Agent pagination cursor/u,
  );
  assert.equal(requests, 2);
});

test("keeps a finite safety bound for Code Agent pagination", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return jsonResponse({
      success: true,
      data: {
        tasks: [],
        nextCursor: `cursor-${String(requests)}`,
      },
    });
  };

  await assert.rejects(
    listCodeAgentTasks(fetchImpl, RUNTIME),
    /Code Agent task pagination exceeded the acceptance bound/u,
  );
  assert.equal(requests, 100);
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

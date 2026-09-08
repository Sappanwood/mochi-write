import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import console from "node:console";
const root = await mkdtemp("/tmp/mochi-real-crash-");
const children = [];
function start(mode) {
  const child = fork(
    fileURLToPath(
      new globalThis.URL("./creative-crash-child.mjs", import.meta.url),
    ),
    [root, mode],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const received = [];
  child.on("message", (message) => received.push(message));
  const next = async (type) => {
    const found = received.find((message) => message.type === type);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Child ${type} timeout: ${stderr}`));
      }, 15000);
      const message = (value) => {
        if (value.type === type) {
          cleanup();
          resolve(value);
        }
      };
      const exit = (code, signal) => {
        cleanup();
        reject(new Error(`Child exited ${code}/${signal}: ${stderr}`));
      };
      function cleanup() {
        clearTimeout(timer);
        child.off("message", message);
        child.off("exit", exit);
      }
      child.on("message", message);
      child.on("exit", exit);
    });
  };
  return { child, next };
}
async function request(origin, path, body, status = 200) {
  const response = await globalThis.fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer isolated-child-client",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}
try {
  const initial = start("initial");
  const { origin } = await initial.next("ready");
  const session = await request(
    origin,
    "/v1/sessions",
    {
      system_prompt: "Isolated process crash acceptance",
      tools: [
        {
          name: "create_chapter",
          version: "1",
          description: "Isolated pending chapter callback",
          effect: "write",
          parameters: {
            type: "object",
            properties: { mode: { type: "string", enum: ["commit"] } },
            required: ["mode"],
            additionalProperties: false,
          },
        },
      ],
    },
    201,
  );
  const operationId = randomUUID();
  const input = {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    prompt: "Invoke the isolated pending callback",
    idempotency_key: randomUUID(),
    max_output_tokens: 1024,
    scope: {
      task_id: randomUUID(),
      story_id: randomUUID(),
      source_message_id: randomUUID(),
      operation_id: operationId,
      authorization_id: randomUUID(),
    },
    budget: {
      max_model_calls: 2,
      max_tool_calls: 1,
      max_write_operations: 1,
      timeout_ms: 60000,
    },
  };
  const run = await request(
    origin,
    `/v1/sessions/${session.session_id}/runs`,
    input,
    202,
  );
  const pending = await initial.next("callback");
  assert.equal(pending.modelCalls, 1);
  assert.equal(pending.callbacks, 1);
  const file = join(
    root,
    "mochi-write",
    session.session_id,
    `${run.run_id}.json`,
  );
  const before = JSON.parse(await readFile(file, "utf8"));
  assert.equal(before.status, "running");
  assert.equal(before.invocations[0].status, "dispatched");
  assert.ok(
    before.messages.some(
      (entry) => (entry.message ?? entry).role === "assistant",
    ),
  );
  const killed = once(initial.child, "exit");
  initial.child.kill("SIGKILL");
  assert.deepEqual(await killed, [null, "SIGKILL"]);
  // Only this trusted test directory's stale lock is removed after confirmed process death.
  await rm(join(root, ".owner"), { recursive: true });
  const restarted = start("recover");
  const ready = await restarted.next("ready");
  assert.equal(ready.modelCalls, 0);
  assert.equal(ready.dispatches, 0);
  assert.equal(ready.callbacks, 0);
  const recovered = await request(ready.origin, `/v1/runs/${run.run_id}`);
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.operations[0].operation_id, operationId);
  assert.equal(recovered.operations[0].status, "unknown");
  const same = await request(
    ready.origin,
    `/v1/sessions/${session.session_id}/runs`,
    input,
    202,
  );
  assert.equal(same.run_id, run.run_id);
  assert.equal(same.status, "interrupted");
  const after = JSON.parse(await readFile(file, "utf8"));
  assert.equal(after.invocations[0].status, "unknown");
  assert.deepEqual(after.messages, before.messages);
  restarted.child.send("counts");
  const counts = await restarted.next("counts");
  assert.equal(counts.modelCalls, 0);
  assert.equal(counts.callbacks, 0);
  assert.equal(counts.dispatches, 0);
  const closed = once(restarted.child, "exit");
  restarted.child.send("close");
  assert.deepEqual(await closed, [0, null]);
  console.log(
    JSON.stringify({
      ok: true,
      acceptance: "real_sigkill_during_dispatched_tool",
      persistent_store_reopened_in_new_process: true,
      interrupted_unknown_retained: true,
      unchanged_pi_history: true,
      provider_or_callback_replay: false,
      stale_test_lock_removed_after_confirmed_exit: true,
    }),
  );
} finally {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}

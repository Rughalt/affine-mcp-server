#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  classifyToolError,
  sanitizeOperationalDetail,
  wrapToolHandler,
} from "../dist/toolExecution.js";
import {
  WorkspaceSocketBusyError,
  WorkspaceSocketCapacityLimiter,
} from "../dist/ws.js";
import { loadWsRuntimeConfig } from "../dist/wsRuntimeConfig.js";

function payload(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

assert.equal(
  sanitizeOperationalDetail("Authorization: Bearer super-secret\nboom"),
  "Authorization=[redacted] boom",
);

let attempts = 0;
const readHandler = wrapToolHandler("read_doc", true, async () => {
  attempts += 1;
  if (attempts === 1) throw Object.assign(new Error("GraphQL HTTP 502: upstream unavailable"), { status: 502 });
  return { content: [{ type: "text", text: "ok" }] };
});
assert.equal((await readHandler({})).content[0].text, "ok");
assert.equal(attempts, 2, "read-only transient failures should retry exactly once");

attempts = 0;
const writeHandler = wrapToolHandler("update_doc_title", false, async () => {
  attempts += 1;
  throw new Error("space:push-doc-update timeout after 10000ms");
});
const writeFailure = payload(await writeHandler({}));
assert.equal(attempts, 1, "writes must never retry automatically");
assert.equal(writeFailure.code, "upstream_websocket_error");
assert.equal(writeFailure.type, "upstream_websocket_error");
assert.match(writeFailure.detail, /push-doc-update timeout/);
assert.equal(writeFailure.retryable, false);
assert.equal(writeFailure.outcome, "unknown");
assert.equal(writeFailure.operation, "affine.update_doc_title");
assert.match(writeFailure.requestId, /^[0-9a-f-]{36}$/);

const invalidSignature = classifyToolError(new Error("JWT signature verification failed"));
assert.equal(invalidSignature.retryable, false);
assert.equal(invalidSignature.code, "internal_error");

const existingFailure = await wrapToolHandler("get_doc", true, async () => ({
  content: [{ type: "text", text: "legacy" }],
  structuredContent: { ok: false, code: "not_found", error: "missing", retryable: false },
  isError: true,
}))({});
assert.equal(payload(existingFailure).operation, "affine.get_doc");
assert.equal(payload(existingFailure).type, "not_found");
assert.equal(payload(existingFailure).detail, "missing");
assert.match(payload(existingFailure).requestId, /^[0-9a-f-]{36}$/);

assert.deepEqual(loadWsRuntimeConfig({}), {
  maxConcurrent: 32,
  maxQueue: 64,
  queueTimeoutMs: 5000,
  connectTimeoutMs: 10000,
  ackTimeoutMs: 10000,
});
assert.throws(
  () => loadWsRuntimeConfig({ AFFINE_WS_MAX_CONCURRENT: "0" }),
  /must be an integer/,
);

const limiter = new WorkspaceSocketCapacityLimiter({
  maxConcurrent: 1,
  maxQueue: 1,
  queueTimeoutMs: 100,
});
const releaseFirst = await limiter.acquire();
const queued = limiter.acquire();
await assert.rejects(
  limiter.acquire(),
  error => error instanceof WorkspaceSocketBusyError
    && error.code === "AFFINE_WS_BUSY"
    && error.capacity.active === 1
    && error.capacity.queued === 1,
);
releaseFirst();
const releaseQueued = await queued;
assert.deepEqual(limiter.snapshot(), {
  resource: "affine_websocket_connections",
  active: 1,
  limit: 1,
  queued: 0,
  queueLimit: 1,
});
releaseQueued();
releaseQueued();
assert.equal(limiter.snapshot().active, 0, "slot release must be idempotent");

const timeoutLimiter = new WorkspaceSocketCapacityLimiter({
  maxConcurrent: 1,
  maxQueue: 1,
  queueTimeoutMs: 100,
});
const releaseTimeoutHolder = await timeoutLimiter.acquire();
await assert.rejects(timeoutLimiter.acquire(), WorkspaceSocketBusyError);
assert.equal(timeoutLimiter.snapshot().queued, 0);
releaseTimeoutHolder();

const abortLimiter = new WorkspaceSocketCapacityLimiter({
  maxConcurrent: 1,
  maxQueue: 1,
  queueTimeoutMs: 5000,
});
const releaseAbortHolder = await abortLimiter.acquire();
const abortController = new AbortController();
const abortedWait = abortLimiter.acquire(abortController.signal);
abortController.abort();
await assert.rejects(abortedWait, error => error.code === "ABORT_ERR");
assert.equal(abortLimiter.snapshot().queued, 0, "cancelled queue entries must be removed");
releaseAbortHolder();

console.log("Operational error and capacity tests passed");

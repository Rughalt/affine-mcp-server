const DEFAULT_MAX_CONCURRENT = 32;
const DEFAULT_MAX_QUEUE = 64;
const DEFAULT_QUEUE_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_ACK_TIMEOUT_MS = 10_000;

export type WsRuntimeConfig = {
  maxConcurrent: number;
  maxQueue: number;
  queueTimeoutMs: number;
  connectTimeoutMs: number;
  ackTimeoutMs: number;
};

function parseInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer between ${min} and ${max}. Received: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}. Received: ${raw}`);
  }
  return value;
}

export function loadWsRuntimeConfig(env: NodeJS.ProcessEnv = process.env): WsRuntimeConfig {
  return {
    maxConcurrent: parseInteger("AFFINE_WS_MAX_CONCURRENT", env.AFFINE_WS_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT, 1, 10_000),
    maxQueue: parseInteger("AFFINE_WS_MAX_QUEUE", env.AFFINE_WS_MAX_QUEUE, DEFAULT_MAX_QUEUE, 0, 100_000),
    queueTimeoutMs: parseInteger("AFFINE_WS_QUEUE_TIMEOUT_MS", env.AFFINE_WS_QUEUE_TIMEOUT_MS, DEFAULT_QUEUE_TIMEOUT_MS, 100, 120_000),
    connectTimeoutMs: parseInteger("AFFINE_WS_CONNECT_TIMEOUT_MS", env.AFFINE_WS_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, 100, 120_000),
    ackTimeoutMs: parseInteger("AFFINE_WS_ACK_TIMEOUT_MS", env.AFFINE_WS_ACK_TIMEOUT_MS, DEFAULT_ACK_TIMEOUT_MS, 100, 120_000),
  };
}

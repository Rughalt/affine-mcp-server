import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { toolError } from "./util/mcp.js";

type ToolResult = Record<string, any>;

type ErrorClassification = {
  code: string;
  detail: string;
  retryable: boolean;
  retryAfterMs?: number;
  status?: number;
};

const toolExecutionContext = new AsyncLocalStorage<{ signal?: AbortSignal }>();

export function currentToolAbortSignal(): AbortSignal | undefined {
  return toolExecutionContext.getStore()?.signal;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(authorization|cookie|set-cookie|token|password)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]"],
  [/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]"],
  [/([?&](?:access_token|token|key|secret|password)=)[^&#\s]+/gi, "$1[redacted]"],
];

export function sanitizeOperationalDetail(value: unknown, maxLength = 300): string {
  const raw = value instanceof Error && value.message
    ? value.message
    : typeof value === "string" && value
      ? value
      : "Unexpected internal failure";
  let safe = raw.replace(/<[^>]*>/g, " ").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of SECRET_PATTERNS) safe = safe.replace(pattern, replacement);
  return safe.length > maxLength ? `${safe.slice(0, maxLength)}...` : safe;
}

function numericProperty(error: unknown, key: string): number | undefined {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringProperty(error: unknown, key: string): string | undefined {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

export function classifyToolError(error: unknown): ErrorClassification {
  const detail = sanitizeOperationalDetail(error);
  const lower = detail.toLowerCase();
  const parsedStatus = Number(/\b(?:http|status)\s+(\d{3})\b/i.exec(detail)?.[1] || NaN);
  const status = numericProperty(error, "status")
    ?? numericProperty(error, "statusCode")
    ?? (Number.isFinite(parsedStatus) ? parsedStatus : undefined);
  const errorCode = stringProperty(error, "code")?.toUpperCase();
  if (errorCode === "ABORT_ERR" || lower === "the operation was aborted") {
    return { code: "request_cancelled", detail, retryable: false };
  }
  const timeout = errorCode === "ETIMEDOUT" || errorCode === "UND_ERR_CONNECT_TIMEOUT"
    || /\b(?:timed? out|timeout|aborted due to timeout)\b/i.test(detail);
  const networkFailure = ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"]
    .includes(errorCode || "") || /socket (?:hang up|disconnected)|network error|fetch failed/i.test(detail);
  const websocket = /socket|websocket|space:(?:join|load-doc|push-doc-update)/i.test(detail);
  const authentication = status === 401 || status === 403
    || /\bunauthori[sz]ed\b|\bforbidden\b|authentication failed/i.test(detail);
  const invalidResponse = /invalid json|non-json response|invalid upstream response/i.test(detail);
  const transientStatus = status === 408 || status === 429 || (status !== undefined && status >= 500);

  if (errorCode === "AFFINE_WS_BUSY") {
    return {
      code: "upstream_busy",
      detail,
      retryable: true,
      retryAfterMs: numericProperty(error, "retryAfterMs") ?? 1_000,
    };
  }
  if (authentication) return { code: "authentication_error", detail, retryable: false, status };
  if (timeout) {
    return { code: websocket ? "upstream_websocket_error" : "upstream_timeout", detail, retryable: true, status };
  }
  if (websocket) return { code: "upstream_websocket_error", detail, retryable: networkFailure, status };
  if (status !== undefined) {
    return { code: "upstream_http_error", detail, retryable: transientStatus, status };
  }
  if (networkFailure) return { code: "upstream_http_error", detail, retryable: true };
  if (invalidResponse) return { code: "invalid_upstream_response", detail, retryable: false };
  return { code: "internal_error", detail, retryable: false };
}

function isErrorResult(value: unknown): value is ToolResult {
  return Boolean(value && typeof value === "object" && (value as ToolResult).isError === true);
}

function enrichErrorResult(result: ToolResult, operation: string, requestId: string): ToolResult {
  const existing = result.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent as Record<string, unknown>
    : {};
  const safeError = sanitizeOperationalDetail(existing.error);
  const payload = {
    ...existing,
    error: safeError,
    type: typeof existing.type === "string"
      ? existing.type
      : typeof existing.code === "string"
        ? existing.code
        : "tool_error",
    detail: typeof existing.detail === "string"
      ? sanitizeOperationalDetail(existing.detail)
      : safeError,
    operation: typeof existing.operation === "string" ? existing.operation : operation,
    requestId: typeof existing.requestId === "string" ? existing.requestId : requestId,
  };
  return {
    ...result,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function abortSignalFromHandlerArgs(args: unknown[]): AbortSignal | undefined {
  const candidate = args[1] && typeof args[1] === "object"
    ? (args[1] as Record<string, unknown>).signal
    : undefined;
  return candidate instanceof AbortSignal ? candidate : undefined;
}

function retryDelayMs(classification: ErrorClassification): number {
  return Math.max(100, Math.min(classification.retryAfterMs ?? 250, 5_000));
}

export function wrapToolHandler(
  toolName: string,
  readOnly: boolean,
  handler: (...args: any[]) => any,
): (...args: any[]) => Promise<any> {
  const operation = `affine.${toolName}`;
  return async (...args: any[]) => {
    const requestId = randomUUID();
    const signal = abortSignalFromHandlerArgs(args);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await toolExecutionContext.run({ signal }, () => handler(...args));
        return isErrorResult(result) ? enrichErrorResult(result, operation, requestId) : result;
      } catch (error) {
        const classification = classifyToolError(error);
        const shouldRetry = readOnly && attempt === 1 && classification.retryable && !signal?.aborted;
        console.error(
          `[affine-mcp] Tool ${operation} failed (requestId=${requestId}, attempt=${attempt}, ` +
          `code=${classification.code}, retryable=${classification.retryable}):`,
          error,
        );
        if (shouldRetry) {
          try {
            await delay(retryDelayMs(classification), undefined, signal ? { signal } : undefined);
            continue;
          } catch {
            return toolError("Tool request was cancelled", {
              code: "request_cancelled",
              retryable: false,
              data: {
                type: "request_cancelled",
                detail: "Tool request was cancelled",
                operation,
                requestId,
                outcome: "failed",
              },
              details: { attempts: attempt },
            });
          }
        }

        const outcome = readOnly
          ? "failed"
          : classification.code === "upstream_busy"
            ? "not_started"
            : classification.code.includes("timeout")
              || classification.code === "upstream_websocket_error"
              ? "unknown"
              : "failed";
        return toolError(classification.detail, {
          code: classification.code,
          retryable: classification.retryable && (readOnly || outcome === "not_started"),
          data: {
            type: classification.code,
            detail: classification.detail,
            operation,
            requestId,
            outcome,
            ...(classification.code.startsWith("upstream_") ? { upstream: "affine" } : {}),
            ...(classification.status !== undefined ? { status: classification.status } : {}),
            ...(classification.retryAfterMs !== undefined
              ? { retryAfterMs: retryDelayMs(classification) }
              : {}),
            ...(error && typeof error === "object" && "capacity" in error
              ? { capacity: (error as Record<string, unknown>).capacity }
              : {}),
          },
          details: { attempts: attempt },
        });
      }
    }
  };
}

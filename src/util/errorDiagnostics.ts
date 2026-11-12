type ErrorDiagnosticsOptions = {
  secrets?: Array<string | undefined>;
};

const SENSITIVE_FIELD =
  /\b(password|passwd|authorization|proxy-authorization|cookie|set-cookie|token|api[-_]?key|secret)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;

function redactSensitiveText(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/\b(Bearer\s+)[^\s,;}\]]+/gi, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(SENSITIVE_FIELD, (_match, name: string, separator: string) =>
      `${name}${separator}[REDACTED]`);
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function formatUnknownError(
  error: unknown,
  secrets: string[],
  seen: Set<object>,
): string {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return redactSensitiveText(String(error), secrets);
  }
  if (seen.has(error)) return "[Circular error cause]";
  seen.add(error);

  const detail = error as Record<string, unknown>;
  const name = typeof detail.name === "string" ? detail.name : "Error";
  const message = typeof detail.message === "string" ? detail.message : String(error);
  const stack = typeof detail.stack === "string"
    ? detail.stack
    : `${name}: ${message}`;
  const lines = [redactSensitiveText(stack, secrets)];

  for (const field of ["code", "errno", "syscall", "address", "port"] as const) {
    const value = detail[field];
    if (typeof value === "string" || typeof value === "number") {
      lines.push(`${field}: ${redactSensitiveText(String(value), secrets)}`);
    }
  }

  if (Array.isArray(detail.errors)) {
    detail.errors.forEach((nested, index) => {
      lines.push(`error[${index}]:\n${indent(formatUnknownError(nested, secrets, seen), 2)}`);
    });
  }
  if ("cause" in detail && detail.cause !== undefined) {
    lines.push(`cause:\n${indent(formatUnknownError(detail.cause, secrets, seen), 2)}`);
  }
  return lines.join("\n");
}

/**
 * Format an error and its cause chain for server-side diagnostics. Only a
 * small allowlist of network fields is included, and all text is redacted.
 */
export function formatErrorDiagnostics(
  error: unknown,
  options: ErrorDiagnosticsOptions = {},
): string {
  const secrets = (options.secrets || []).filter(
    (secret): secret is string => typeof secret === "string" && secret.length > 0,
  );
  return formatUnknownError(error, secrets, new Set());
}


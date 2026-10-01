const REDACTED = "[REDACTED]";
const SAFE_TOKEN_FIELDS = /^(?:tokensSpent|inputTokens|outputTokens|totalTokens|maxTokens|tokenCount|tokenBudget)$/i;

/**
 * Versioned, deterministic boundary redaction for logs and provider payloads.
 * It intentionally favors false positives over transmitting credential-shaped
 * values. This is not a substitute for excluding secret files at collection.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,"']+/gi, `$1${REDACTED}`)
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]{16,}/gi, `$1${REDACTED}`)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(
      /((?:api[_-]?key|secret[_-]?key|access[_-]?token|password|client[_-]?secret|authorization)\s*[:=]\s*["']?)[^\s,"']{8,}/gi,
      `$1${REDACTED}`,
    )
    .replace(/(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)[\s\S]*?(-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g,
      `$1\n${REDACTED}\n$2`);
}

/** Redact strings recursively before structured values cross a log boundary. */
export function redactUnknown(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, seen));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = !SAFE_TOKEN_FIELDS.test(key) && /token|secret|password|authorization|api[-_]?key/i.test(key)
      ? REDACTED
      : redactUnknown(item, seen);
  }
  return output;
}

const REDACTED = "[REDACTED]";
const SAFE_TOKEN_FIELDS = /^(?:tokensSpent|inputTokens|outputTokens|totalTokens|maxTokens|tokenCount|tokenBudget|maxOutputTokens|contextWindowTokens|runMaxTokens|agentMaxTokens)$/i;

/**
 * Versioned, deterministic boundary redaction for logs, errors, events, reports,
 * and provider payloads. Covers the contract SEC-10 pattern list:
 * - Bearer / Basic authorization headers
 * - URL userinfo / x-access-token credentials
 * - Known provider / cloud key prefixes (sk-, ghp_, github_pat_, AKIA)
 * - KEY=value and key: value secret assignments (including high-entropy values)
 * - PEM private key blocks
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,"']+/gi, `$1${REDACTED}`)
    .replace(/((?:bearer|basic)\s+)[A-Za-z0-9._~+\/=-]{12,}/gi, `$1${REDACTED}`)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/(x-access-token:)[^\s/@]+/gi, `$1${REDACTED}`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16})\b/g, REDACTED)
    .replace(
      /((?:[A-Z0-9_]*(?:API[_-]?KEY|SECRET(?:[_-]?KEY)?|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SERVER[_-]?TOKEN|PRIVATE[_-]?KEY|PASSWORD|CLIENT[_-]?SECRET|CREDENTIAL)[A-Z0-9_]*|api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|server[_-]?token|password|client[_-]?secret|authorization|canary[_-]?secret)\s*[:=]\s*["']?)[^\s,"'\r\n]{6,}/gi,
      `$1${REDACTED}`,
    )
    .replace(/(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)[\s\S]*?(-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g,
      `$1\n${REDACTED}\n$2`);
}

/** Redact strings recursively before structured values cross a log or persistence boundary. */
export function redactUnknown(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, seen));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = !SAFE_TOKEN_FIELDS.test(key) && /token|secret|password|authorization|api[-_]?key|credential/i.test(key)
      ? REDACTED
      : redactUnknown(item, seen);
  }
  return output;
}

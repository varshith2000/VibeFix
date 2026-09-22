import { LlmError, httpErrorKind } from "../errors.js";

export interface HttpPostOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function postJson<T>(opts: HttpPostOptions): Promise<T> {
  const timeout = opts.timeoutMs ?? 120_000;

  // Transient upstream errors (429/5xx, e.g. Gemini "overloaded" 503s) are
  // common under load. Retry with backoff before surfacing an error — a
  // failed call here means a rejected change attempt a layer above.
  const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
  const BACKOFF_MS = [1_000, 4_000, 9_000];
  let lastError: LlmError | undefined;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1]!);
    const timer = new AbortController();
    const timeoutSignal = AbortSignal.timeout(timeout);
    const onTimeout = () => timer.abort();
    timeoutSignal.addEventListener("abort", onTimeout, { once: true });
    opts.signal?.addEventListener("abort", onTimeout, { once: true });

    let res: Response;
    try {
      res = await fetch(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        body: JSON.stringify(opts.body),
        signal: timer.signal,
      });
    } catch (err) {
      timeoutSignal.removeEventListener("abort", onTimeout);
      lastError = new LlmError("network", `request failed: ${String(err)}`, "unknown", undefined, err);
      continue; // network errors are transient by nature
    } finally {
      timeoutSignal.removeEventListener("abort", onTimeout);
    }
    if (res.ok) return (await res.json()) as T;

    const body = await res.text().catch(() => "");
    lastError = new LlmError(
      httpErrorKind(res.status),
      `HTTP ${res.status}: ${body.slice(0, 500)}`,
      "unknown",
      res.status,
    );
    if (!RETRYABLE.has(res.status)) throw lastError;
  }
  throw lastError ?? new LlmError("network", "request failed", "unknown");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the first balanced JSON value from model text. Handles prose-wrapped
 * JSON and fenced code blocks — models ignore "JSON only" instructions sometimes.
 */
export function extractFirstJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text.trim());

  for (const candidate of candidates) {
    if (candidate.startsWith("{") || candidate.startsWith("[")) {
      try {
        return JSON.parse(candidate);
      } catch {
        // fall through to brace matching
      }
    }
    // Brace matching: find first '{' or '[' and scan to its balanced close.
    const start = candidate.search(/[{[]/);
    if (start === -1) continue;
    const open = candidate[start]!;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new LlmError("invalid-response", "no JSON object found in model output", "unknown");
}

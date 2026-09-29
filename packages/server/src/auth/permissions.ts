const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export function assertBindingAllowed(host: string): void {
  if (isLoopbackHost(host)) return;
  const optedIn = process.env.VIBEFIX_ALLOW_REMOTE === "1";
  const hasToken = (process.env.VIBEFIX_API_TOKEN ?? "").length >= 16;
  if (!optedIn || !hasToken) {
    throw new Error(
      `refusing to bind ${host}: VibeFix serves filesystem reads and code-modification ` +
        `endpoints. To expose it beyond loopback, set BOTH VIBEFIX_ALLOW_REMOTE=1 and ` +
        `VIBEFIX_API_TOKEN (>= 16 chars) in the environment.`,
    );
  }
}
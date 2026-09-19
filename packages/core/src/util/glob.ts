/**
 * Minimal POSIX glob -> RegExp. Supports `*` (within a segment), `**`
 * (across segments), `?`, and literal everything-else. Leading dirs are
 * repo-relative; patterns match the full path.
 */
export function globToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // '**' — also swallow an immediately following '/'
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else {
      re += escapeRegex(ch);
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

export function globMatch(pattern: string, path: string): boolean {
  return globToRegex(pattern).test(path);
}

/** True if any pattern matches. */
export function globMatchAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => globMatch(p, path));
}

function escapeRegex(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

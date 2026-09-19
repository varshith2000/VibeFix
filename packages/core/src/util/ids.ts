import { randomUUID } from "node:crypto";

/** Monotonic-ish, sortable ids for runs/artifacts/ledger entries. */
export function runId(): string {
  return `run_${base36Date()}${base36Rand(6)}`;
}

export function artifactId(): string {
  return `art_${base36Date()}${base36Rand(8)}`;
}

export function ledgerId(): string {
  return `led_${base36Date()}${base36Rand(6)}`;
}

export function eventId(): string {
  return `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function base36Date(): string {
  return Date.now().toString(36);
}

function base36Rand(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 36).toString(36);
  return out;
}

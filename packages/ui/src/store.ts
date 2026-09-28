import { create } from "zustand";
import { api, encPath } from "./api";
import type { RunEvent, RunState } from "./types";

type WsStatus = "connecting" | "live" | "offline";

interface RunStore {
  runId: string | null;
  repoPath: string | null;
  runState: RunState | null;
  events: RunEvent[];
  usage: { total: number; byAgent: Record<string, number>; byProvider: Record<string, number> };
  ws: WebSocket | null;
  wsStatus: WsStatus;
  lastEventAt: number | null;
  connect(runId: string, repoPath: string): void;
  disconnect(): void;
  /** REST resync (initial load, WS drop, or polling fallback). Idempotent by eventId. */
  syncEvents(): Promise<void>;
  applySnapshot(state: RunState): void;
  applyUsage(usage: RunStore["usage"]): void;
  pushEvent(event: RunEvent): void;
}

const EMPTY_USAGE = { total: 0, byAgent: {}, byProvider: {} };

export const useRunStore = create<RunStore>((set, get) => ({
  runId: null,
  repoPath: null,
  runState: null,
  events: [],
  usage: EMPTY_USAGE,
  ws: null,
  wsStatus: "offline",
  lastEventAt: null,

  connect(runId: string, repoPath: string) {
    get().disconnect();
    set({ usage: EMPTY_USAGE, events: [], lastEventAt: null, wsStatus: "connecting", runId, repoPath });
    void get().syncEvents(); // durable REST log works even if WS never connects

    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;
    const baseReconnectDelay = 1_000;
    const maxReconnectDelay = 30_000;

    const attemptConnection = () => {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      // Project-scoped: the server refuses a runId that does not belong to
      // the named project (enc), and the token reaches it via the Vite proxy.
      const ws = new WebSocket(
        `${protocol}://${location.host}/ws?runId=${encodeURIComponent(runId)}&enc=${encodeURIComponent(encPath(repoPath))}`,
      );
      
      ws.onopen = () => {
        reconnectAttempts = 0;
        set({ wsStatus: "live" });
        void get().syncEvents(); // catch anything missed before the socket opened
      };
      
      ws.onmessage = (msg) => {
        try {
          const frame = JSON.parse(msg.data as string) as
            | { t: "snapshot"; state: RunState }
            | { t: "usage"; usage: RunStore["usage"] }
            | { t: "event"; event: RunEvent; seq: number }
            | { t: "readonly"; runId: string };
          if (frame.t === "snapshot") get().applySnapshot(frame.state);
          else if (frame.t === "usage") get().applyUsage(frame.usage);
          else if (frame.t === "event") get().pushEvent(frame.event);
          else if (frame.t === "readonly") set({ wsStatus: "offline" }); // replay-only socket; REST polling feeds updates
        } catch {
          // ignore malformed frame
        }
      };
      
      ws.onclose = () => {
        if (get().runId !== runId) return;
        set({ wsStatus: "offline" });
        
        // Exponential backoff reconnection logic
        if (reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          const delay = Math.min(baseReconnectDelay * Math.pow(2, reconnectAttempts - 1), maxReconnectDelay);
          setTimeout(() => {
            if (get().runId === runId) attemptConnection();
          }, delay);
        } else {
          // After max attempts, rely solely on REST polling
          console.warn(`[VibeFix] WebSocket reconnection failed after ${maxReconnectAttempts} attempts, using REST polling`);
        }
      };
      
      ws.onerror = () => {
        console.warn(`[VibeFix] WebSocket error, attempting reconnection (attempt ${reconnectAttempts + 1}/${maxReconnectAttempts})`);
      };
      
      set({ runId, ws });
    };

    attemptConnection();
  },

  async syncEvents() {
    const { runId, repoPath, events } = get();
    if (!runId || !repoPath) return;
    try {
      const lastSeq = events.length > 0 ? (events[events.length - 1]?.seq ?? 0) : 0;
      const { events: newEvents } = await api.events(repoPath, runId, lastSeq);
      if (get().runId !== runId || newEvents.length === 0) return;
      set((s) => {
        const seen = new Set(s.events.map((e) => e.eventId));
        const fresh = newEvents.filter((e) => !seen.has(e.eventId));
        if (fresh.length === 0) return {};
        const merged = [...s.events, ...fresh].sort((a, b) => a.seq - b.seq).slice(-500);
        return { events: merged, lastEventAt: Date.now() };
      });
    } catch (err) {
      // server unreachable — polling retries, but log the error for debugging
      console.warn(`[VibeFix] Failed to sync events: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  disconnect() {
    const { ws } = get();
    set({ runId: null, repoPath: null, wsStatus: "offline" });
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  },

  applySnapshot(state) {
    set({ runState: state });
  },

  applyUsage(usage) {
    set({ usage });
  },

  pushEvent(event) {
    set((s) => {
      // WS and REST can both deliver the same event — dedupe by eventId.
      if (s.events.some((e) => e.eventId === event.eventId)) return {};
      return { events: [...s.events.slice(-499), event].sort((a, b) => a.seq - b.seq), lastEventAt: Date.now() };
    });
    // Snapshot-bearing events refresh agent states too.
    if (
      event.type.startsWith("agent.") ||
      event.type.startsWith("phase.") ||
      event.type.startsWith("checkpoint.") ||
      event.type.startsWith("run.")
    ) {
      const currentState = get().runState;
      if (currentState) {
        let next: RunState = currentState;
        if (event.type === "agent.started" && event.agentId) {
          next = { ...next, agentStates: { ...next.agentStates, [event.agentId]: "running" } };
        } else if (event.type === "agent.completed" && event.agentId) {
          next = { ...next, agentStates: { ...next.agentStates, [event.agentId]: "passed" } };
        } else if ((event.type === "agent.failed" || event.type === "agent.rejected") && event.agentId) {
          next = { ...next, agentStates: { ...next.agentStates, [event.agentId]: event.type === "agent.failed" ? "failed" : "rejected" } };
        }
        if (event.type === "phase.entered") {
          next = { ...next, phase: event.message as RunState["phase"] };
        }
        // Status transitions — applied the moment the event lands so the
        // header never shows a stale "awaitingApproval" after the user clicks
        // Approve (the authoritative snapshot follows within ms).
        if (event.type === "checkpoint.awaitingApproval") {
          next = { ...next, status: "awaitingApproval", phase: "awaitingApproval" };
        } else if (event.type === "checkpoint.approved") {
          next = { ...next, status: "running" };
        } else if (event.type === "run.completed" || event.type === "run.nochanges") {
          next = { ...next, status: "completed" };
        } else if (event.type === "run.aborted") {
          next = { ...next, status: "aborted" };
        } else if (event.type === "run.failed") {
          next = { ...next, status: "failed" };
        }
        if (next !== currentState) set({ runState: next });
      }
    }
  },
}));

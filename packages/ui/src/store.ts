import { create } from "zustand";
import { api } from "./api";
import type { RunEvent, RunState } from "./types";

type WsStatus = "connecting" | "live" | "offline";

interface RunStore {
  runId: string | null;
  runState: RunState | null;
  events: RunEvent[];
  usage: { total: number; byAgent: Record<string, number>; byProvider: Record<string, number> };
  ws: WebSocket | null;
  wsStatus: WsStatus;
  lastEventAt: number | null;
  connect(runId: string): void;
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
  runState: null,
  events: [],
  usage: EMPTY_USAGE,
  ws: null,
  wsStatus: "offline",
  lastEventAt: null,

  connect(runId: string) {
    get().disconnect();
    set({ usage: EMPTY_USAGE, events: [], lastEventAt: null, wsStatus: "connecting" });
    void get().syncEvents(); // durable REST log works even if WS never connects
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/ws?runId=${runId}`);
    ws.onopen = () => {
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
      // Reconnect with backoff; the REST event log (and 3s polling) keeps the
      // UI fed meanwhile, so a dropped socket never means a blank stream.
      setTimeout(() => {
        if (get().runId === runId) get().connect(runId);
      }, 2_000);
    };
    set({ runId, ws });
  },

  async syncEvents() {
    const { runId } = get();
    if (!runId) return;
    try {
      const { events } = await api.events(runId);
      if (get().runId !== runId || events.length === 0) return;
      set((s) => {
        const seen = new Set(s.events.map((e) => e.eventId));
        const fresh = events.filter((e) => !seen.has(e.eventId));
        if (fresh.length === 0) return {};
        const merged = [...s.events, ...fresh].sort((a, b) => a.seq - b.seq).slice(-500);
        return { events: merged, lastEventAt: Date.now() };
      });
    } catch {
      // server unreachable — polling retries
    }
  },

  disconnect() {
    const { ws } = get();
    set({ runId: null, wsStatus: "offline" });
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
        if (event.type === "agent.started" && event.agentId) {
          set({ runState: { ...currentState, agentStates: { ...currentState.agentStates, [event.agentId]: "running" } } });
        } else if (event.type === "agent.completed" && event.agentId) {
          set({ runState: { ...currentState, agentStates: { ...currentState.agentStates, [event.agentId]: "passed" } } });
        } else if ((event.type === "agent.failed" || event.type === "agent.rejected") && event.agentId) {
          set({ runState: { ...currentState, agentStates: { ...currentState.agentStates, [event.agentId]: event.type === "agent.failed" ? "failed" : "rejected" } } });
        } else if (event.type.startsWith("phase.")) {
          set({ runState: { ...currentState, phase: event.type === "phase.entered" ? (event.message as RunState["phase"]) : currentState.phase } });
        }
      }
    }
  },
}));

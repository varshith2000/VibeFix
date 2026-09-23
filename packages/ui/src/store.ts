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
    
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;
    const baseReconnectDelay = 1_000;
    const maxReconnectDelay = 30_000;
    
    const attemptConnection = () => {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${protocol}://${location.host}/ws?runId=${runId}`);
      
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
    const { runId, events } = get();
    if (!runId) return;
    try {
      const lastSeq = events.length > 0 ? events[events.length - 1].seq : 0;
      const { events: newEvents } = await api.events(runId, lastSeq);
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

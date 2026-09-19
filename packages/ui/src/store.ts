import { create } from "zustand";
import type { RunEvent, RunState } from "./types";

interface RunStore {
  runId: string | null;
  runState: RunState | null;
  events: RunEvent[];
  ws: WebSocket | null;
  connect(runId: string): void;
  disconnect(): void;
  applySnapshot(state: RunState): void;
  pushEvent(event: RunEvent): void;
}

export const useRunStore = create<RunStore>((set, get) => ({
  runId: null,
  runState: null,
  events: [],
  ws: null,

  connect(runId: string) {
    get().disconnect();
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/ws?runId=${runId}`);
    ws.onmessage = (msg) => {
      try {
        const frame = JSON.parse(msg.data as string) as
          | { t: "snapshot"; state: RunState }
          | { t: "event"; event: RunEvent; seq: number };
        if (frame.t === "snapshot") get().applySnapshot(frame.state);
        else get().pushEvent(frame.event);
      } catch {
        // ignore malformed frame
      }
    };
    ws.onclose = () => {
      // simple reconnect with backoff; server keeps the event log for resync
      if (get().runId === runId) {
        setTimeout(() => {
          if (get().runId === runId) get().connect(runId);
        }, 2_000);
      }
    };
    set({ runId, ws, events: [] });
  },

  disconnect() {
    const { ws, runId } = get();
    set({ runId: null });
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    void runId;
  },

  applySnapshot(state) {
    set({ runState: state });
  },

  pushEvent(event) {
    set((s) => ({ events: [...s.events.slice(-499), event] }));
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

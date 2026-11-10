export const title = "hermesd session actor: one session, its turns, compaction and restarts";

const turnLabel = (v: any): string => {
  if (v.turn === "none") return v.asking ? "Waiting for your answer" : "Idle";
  if (v.turn === "held") return "Held: a tool outcome is unknown";
  if (v.stopped) return "Stopping";
  if (v.turn === "tools") return "Running tools";
  return v.inflight ? "Waiting for the model" : "Model call written";
};

export const state = (v: any) => ({
  Turn: turnLabel(v),
  Compaction: v.link === "none" ? "Not compacted" : v.link === "started" ? "Child written, parent not retired" : "Compacted",
  Owner: v.owner === "down" ? "Crashed" : v.adopted ? "Running" : "Restarted, not adopted yet",
});

export const step = (a: string): string | null =>
  ({
    YouSend: "you send a message",
    TurnStarts: "your next input starts a turn",
    CallGoesOut: "the model call goes out",
    ModelAnswers: "the model replies with text",
    ModelCallsTools: "the model asks for tools",
    ModelAsksClarify: "the model asks you a question",
    ModelFails: "the model call fails",
    ToolsFinish: "the tools finish",
    ToolUnknown: "a tool outcome is unknown",
    YouResolveUnknown: "you resolve the unknown outcome",
    YouStop: "you press stop",
    StopEndsTurn: "the stop ends the turn",
    CompactStarts: "you compact (commit 1)",
    CompactFinishes: "commit 2 retires the parent",
    Crash: "the owner crashes",
    Restart: "a wake starts a new owner",
    Adopt: "the new owner adopts (repair, fence, sweep)",
  })[a] ?? a;

export const group = (v: any) => (v.turn === "held" ? "Held" : v.turn === "none" ? "No turn running" : "Turn running");
export const colors = { "No turn running": "teal", "Turn running": "blue", Held: "orange" };

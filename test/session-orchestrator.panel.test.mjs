import assert from "node:assert/strict";
import test from "node:test";
import { loadHarness } from "./session-orchestrator.harness.mjs";

function withActiveSession(h, initial = { sessionId: "parent", activeTurn: null }) {
  let state = { ...initial };
  let promptResult = () => ({ accepted: true, turnId: "parent-turn-1" });
  h.operations.push({ id: "agent/prompt" });
  h.pi.session = {
    getActive: async () => ({ ...state }),
  };
  h.beforeInvoke = async (request) => {
    if (request.operation === "agent/prompt") return promptResult(request);
    return undefined;
  };
  return {
    setSession(next) { state = { ...state, ...next }; },
    setPromptResult(fn) { promptResult = fn; },
  };
}

test("panel init and list expose parent busy state, bound status fan-out to 16, and prioritize recent sessions", async (t) => {
  const h = await loadHarness(t, {
    initialSettings: {
      version: 3,
      sessions: [{ sessionId: "recent-worker", title: "Recent Worker", referencedBy: ["orchestrator-ui"], updatedAt: "2026-10-01T00:00:00.000Z" }],
      acceptances: [],
    },
  });
  const active = withActiveSession(h, { sessionId: "parent", activeTurn: { turnId: "t-busy", startedAt: Date.now() } });
  h.sessions.set("recent-worker", { sessionId: "recent-worker", title: "Recent Worker", status: "completed" });
  for (let i = 0; i < 30; i += 1) {
    h.sessions.set(`dir-${i}`, { sessionId: `dir-${i}`, title: `Dir ${i}`, status: "idle" });
  }

  const init = await h.main.onPanelInvoke("orchestrator.init");
  assert.equal(init.ok, true);
  assert.equal(init.parentSessionId, "parent");
  assert.equal(init.parentBusy, true);
  assert.equal(init.parentTurnId, "t-busy");

  h.calls.length = 0;
  active.setSession({ activeTurn: null });
  const listed = await h.main.onPanelInvoke("orchestrator.list");
  assert.equal(listed.ok, true);
  assert.equal(listed.parentBusy, false);
  const statusCalls = h.calls.filter((call) => call.operation === "session/collaboration/status");
  assert.ok(statusCalls.length <= 16);
  assert.equal(statusCalls[0].args[0].sessionId, "recent-worker");
});

test("panel spawn and send submit through agent/prompt with synchronous deduplication and retry cleanup", async (t) => {
  const h = await loadHarness(t);
  const active = withActiveSession(h);

  const payload = { task: "Audit concurrency", title: "Auditor", parentSessionId: "parent", requestId: "req-1" };
  const [first, second] = await Promise.all([
    h.main.onPanelInvoke("orchestrator.spawn", payload),
    h.main.onPanelInvoke("orchestrator.spawn", payload),
  ]);
  assert.equal(first.ok, true);
  assert.deepEqual(first, second);
  assert.equal(first.submitted, true);
  const prompts = h.calls.filter((call) => call.operation === "agent/prompt");
  assert.equal(prompts.length, 1);
  const forwarded = JSON.parse(prompts[0].args[0].content.split("\n").at(-1));
  assert.equal(forwarded.action, "spawn");
  assert.equal(forwarded.model, "allowed/claude-sonnet-4-6");
  assert.equal(forwarded.idempotencyKey, "panel:req-1");

  // Pre-admission SESSION_CHANGED cleans up requestId so retry works when switched back
  active.setSession({ sessionId: "other" });
  const changed = await h.main.onPanelInvoke("orchestrator.send", {
    parentSessionId: "parent", requestId: "req-retry", sessionId: "existing", message: "Follow up",
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, "SESSION_CHANGED");

  active.setSession({ sessionId: "parent" });
  const retried = await h.main.onPanelInvoke("orchestrator.send", {
    parentSessionId: "parent", requestId: "req-retry", sessionId: "existing", message: "Follow up",
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.submitted, true);

  // Unknown admission remains locked against duplicate prompt submission
  active.setPromptResult(() => ({ accepted: false }));
  const unknown1 = await h.main.onPanelInvoke("orchestrator.send", {
    parentSessionId: "parent", requestId: "req-unknown", sessionId: "existing", message: "Once only",
  });
  active.setPromptResult(() => ({ accepted: true, turnId: "turn-2" }));
  const unknown2 = await h.main.onPanelInvoke("orchestrator.send", {
    parentSessionId: "parent", requestId: "req-unknown", sessionId: "existing", message: "Once only",
  });
  assert.equal(unknown1.error.code, "ADMISSION_UNKNOWN");
  assert.equal(unknown2.error.code, "ADMISSION_UNKNOWN");
});

test("panel and Agent session share acceptance records in both directions", async (t) => {
  const h = await loadHarness(t);
  withActiveSession(h);

  const spawned = await h.execute({ action: "spawn", task: "Deliver report" });
  h.complete(spawned.messageId, "Final report content", "completed");

  await h.execute({ action: "accept", sessionId: spawned.sessionId, messageId: spawned.messageId, note: "Agent accepted" });
  const panelList = await h.main.onPanelInvoke("orchestrator.list");
  const panelWorker = panelList.workers.find((w) => w.sessionId === spawned.sessionId);
  assert.equal(panelWorker?.acceptanceStatus, "accepted");

  const spawned2 = await h.execute({ action: "spawn", task: "Second report" });
  h.complete(spawned2.messageId, "Second final report", "completed");
  const panelAccept = await h.main.onPanelInvoke("orchestrator.accept", {
    sessionId: spawned2.sessionId, messageId: spawned2.messageId, note: "Panel accepted",
  });
  assert.equal(panelAccept.ok, true);
  const agentStatus = await h.execute({ action: "status", sessionId: spawned2.sessionId });
  assert.equal(agentStatus.workers[0].acceptanceStatus, "accepted");
  assert.equal(agentStatus.workers[0].acceptance.note, "Panel accepted");
});

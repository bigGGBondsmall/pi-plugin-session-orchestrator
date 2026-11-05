"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const ACTIVE = new Set(["running", "queued", "waiting_permission"]);
  const STATUSES = {
    running: ["running", "● 运行中"], queued: ["queued", "◷ 排队中"],
    waiting_permission: ["permission", "⚠ 等待授权"], completed: ["completed", "✓ 已完成"],
    failed: ["failed", "✕ 失败"], cancelled: ["cancelled", "■ 已取消"],
    interrupted: ["interrupted", "■ 已中断"], error: ["failed", "⚠ 状态读取失败"],
    idle: ["idle", "○ 空闲"], unknown: ["idle", "? 状态未知"]
  };
  const state = {
    models: [], defaultModel: null, sessions: [], workers: [], recent: [], parentSessionId: null,
    parentBusy: false, errorSource: null,
    activeTab: "all", search: "", polling: true, pollTimer: null, refreshing: null,
    expandedSends: new Set(), drafts: new Map(), pending: new Set(), cards: new Map(),
    isSpawning: false, connected: false, spawnRequest: null, action: null, modalRequest: 0
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[ch]));
  }
  function showToast(message, type = "info") {
    const hub = $("toastHub");
    if (!hub) return;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    hub.appendChild(toast);
    setTimeout(() => toast.remove(), 4500);
  }
  function showError(error, source = "action") {
    state.errorSource = source;
    $("errorNotice").textContent = `操作失败：${error.message || error}。未确认成功的任务请先查看主会话，勿重复提交。`;
    $("errorNotice").hidden = false;
    if (source === "action") $("submissionNotice").hidden = true;
  }
  function updateConnection() {
    const notice = $("connectionNotice");
    notice.textContent = !state.connected ? "宿主连接不可用：无法执行操作。请在 PI-Desktop 中打开本面板并刷新。"
      : !state.parentSessionId ? "请先打开一个 Agent 主会话；监控仍可用，新建/追问暂不可提交。"
      : state.parentBusy ? `主会话 ${state.parentSessionId.slice(0, 8)} 正在运行 · 请等当前轮次结束后提交新建或追问。`
      : `主会话 ${state.parentSessionId.slice(0, 8)} · 新建/追问提交给主会话执行；结果按投递 ID 查询。`;
    $("btnSubmitSpawn").disabled = !state.connected || !state.parentSessionId || state.parentBusy || state.isSpawning;
  }
  async function invoke(channel, payload = {}) {
    if (!window.pluginBridge?.invoke) throw Object.assign(new Error("未连接 PI-Desktop 宿主，操作没有执行"), { code: "BRIDGE_UNAVAILABLE" });
    const result = await window.pluginBridge.invoke(channel, payload);
    if (!result || result.ok !== true) {
      const error = result?.error || {};
      throw Object.assign(new Error(error.message || `接口 ${channel} 未返回成功回执`), { code: error.code || "INTERNAL" });
    }
    return result;
  }
  function applyAppearance(appearance) {
    const base = appearance?.base || appearance?.theme;
    const theme = ["light", "dark"].includes(base) ? base : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.base = theme;
  }
  function formatTime(value) {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return "";
    const diff = Date.now() - timestamp;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    return new Date(timestamp).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function normalizeItem(value) {
    const current = value.currentTask;
    const result = value.result;
    const messageId = current?.messageId || result?.messageId || value.messageId || "";
    const resultMatches = !ACTIVE.has(value.status) && (!current?.messageId || (result?.messageId === current.messageId && !ACTIVE.has(current.status) && (!current.turnId || !result?.turnId || current.turnId === result.turnId)));
    const report = resultMatches ? (result?.text || result?.report || result?.content || result?.result || value.report || "") : "";
    return {
      ...value, messageId,
      task: current?.text || current?.content || current?.task || value.task || "",
      report: typeof report === "string" ? report : "",
      updatedAt: value.updatedAt || current?.createdAt || current?.updatedAt || result?.completedAt || result?.updatedAt,
      error: value.error || (resultMatches ? result?.error : ""),
      status: value.status || "unknown",
      modelLabel: value.modelName ? (value.providerName ? `${value.providerName} · ${value.modelName}` : value.modelName) : (value.modelKey || "")
    };
  }
  function getMergedItems() {
    const map = new Map();
    for (const session of state.sessions) map.set(session.sessionId, normalizeItem(session));
    for (const worker of state.workers) map.set(worker.sessionId, normalizeItem({ ...(map.get(worker.sessionId) || {}), ...worker }));
    for (const recent of state.recent) {
      if (!map.has(recent.sessionId)) map.set(recent.sessionId, { ...recent, status: "unknown", messageId: "" });
      else {
        const item = map.get(recent.sessionId);
        item.title ||= recent.title;
        item.updatedAt ||= recent.updatedAt;
      }
    }
    for (const item of map.values()) item.updatedAt ||= item.observedAt;
    return [...map.values()].sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) ||
      (new Date(b.updatedAt).getTime() || 0) - (new Date(a.updatedAt).getTime() || 0));
  }
  function matches(item) {
    if (state.activeTab === "running" && !ACTIVE.has(item.status)) return false;
    if (state.activeTab === "completed" && item.status !== "completed") return false;
    if (state.activeTab === "other" && (ACTIVE.has(item.status) || item.status === "completed")) return false;
    return !state.search || [item.title, item.sessionId, item.task].some(value => String(value || "").toLowerCase().includes(state.search));
  }
  function setSection(card, section, html) {
    const target = card.querySelector(`[data-section="${section}"]`);
    if (target.innerHTML !== html) target.innerHTML = html;
  }
  function draftFor(sessionId) {
    if (!state.drafts.has(sessionId)) state.drafts.set(sessionId, { message: "", kind: "task", request: null });
    return state.drafts.get(sessionId);
  }
  function requestFor(draft, fingerprint) {
    if (draft.request?.fingerprint === fingerprint) return draft.request.id;
    const id = window.crypto.randomUUID();
    draft.request = { id, fingerprint };
    return id;
  }
  function createCard(item) {
    const card = document.createElement("article");
    card.className = "session-card";
    card.dataset.sessionId = item.sessionId;
    card.innerHTML = `
      <div data-section="top" class="card-top"></div>
      <div data-section="mid" class="card-mid"></div>
      <div data-section="actions" class="card-bottom-actions"></div>
      <div class="inline-send-box" data-send-box hidden>
        <textarea rows="3" maxlength="65536" data-send-input placeholder="输入追问或新任务，提交给主会话转发..."></textarea>
        <div class="inline-send-tools">
          <label>消息类型 <select data-send-kind><option value="task">任务指令</option><option value="message">普通消息</option></select></label>
          <div class="inline-send-btns">
            <button class="btn btn-secondary" data-action="close-send">收起</button>
            <button class="btn btn-primary" data-action="submit-send">提交追问</button>
          </div>
        </div>
      </div>`;
    const draft = draftFor(item.sessionId);
    card.querySelector("[data-send-input]").value = draft.message;
    card.querySelector("[data-send-kind]").value = draft.kind;
    return card;
  }
  function renderList() {
    const container = $("sessionsList");
    if (!container) return;
    $("loadingState").hidden = true;
    const items = getMergedItems();
    $("statRunning").textContent = items.filter(item => ACTIVE.has(item.status)).length;
    $("statCompleted").textContent = items.filter(item => item.status === "completed").length;
    $("statIdle").textContent = items.filter(item => !ACTIVE.has(item.status) && item.status !== "completed").length;
    $("statTotal").textContent = items.length;
    const filtered = items.filter(matches);
    $("emptyState").hidden = filtered.length > 0;
    const keep = new Set(filtered.map(item => item.sessionId));
    for (const [id, card] of state.cards) if (!keep.has(id)) { card.remove(); state.cards.delete(id); }
    const currentCards = Array.from(container.querySelectorAll(".session-card"));
    const orderChanged = currentCards.length !== filtered.length || filtered.some((item, i) => currentCards[i]?.dataset.sessionId !== item.sessionId);
    const editing = container.contains(document.activeElement);
    for (const item of filtered) {
      let card = state.cards.get(item.sessionId);
      if (!card) { card = createCard(item); state.cards.set(item.sessionId, card); }
      const isParent = Boolean(state.parentSessionId && item.sessionId === state.parentSessionId);
      if (isParent) state.expandedSends.delete(item.sessionId);
      const [badge, label] = STATUSES[item.status] || STATUSES.unknown;
      setSection(card, "top", `<div class="card-title-group"><span class="status-badge ${badge}">${label}</span><span class="card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title || item.sessionId)}</span></div><button class="session-id-chip" data-action="copy-id" title="复制会话 ID">${escapeHtml(item.sessionId.slice(0, 8))}</button>`);
      setSection(card, "mid", `<div class="meta-info-row">${(item.modelLabel || item.modelKey) ? `<span class="model-tag">${escapeHtml(item.modelLabel || item.modelKey)}</span>` : ""}<span>${escapeHtml(formatTime(item.updatedAt))}</span>${isParent ? '<span class="model-tag">当前主会话</span>' : ""}${item.acceptanceStatus === "accepted" ? '<span class="accepted-tag">✓ 本面板已验收</span>' : ""}</div>
        ${item.task ? `<div class="task-preview">任务：${escapeHtml(item.task)}</div>` : ""}
        ${item.report ? `<div class="task-preview">报告：${escapeHtml(item.report)}</div>` : ""}
        ${item.error ? `<div class="task-preview error-text">${escapeHtml(item.error)}</div>` : ""}
        ${item.messageId ? `<div class="delivery-id">投递 ${escapeHtml(item.messageId)}</div>` : ""}`);
      const pending = state.pending.has(item.sessionId);
      const controlsDisabled = !state.connected || pending;
      const canCancel = ACTIVE.has(item.status) && item.messageId;
      const canAccept = item.status === "completed" && item.messageId;
      const msg = escapeHtml(item.messageId);
      setSection(card, "actions", `
        <button class="btn-action" data-action="open" ${controlsDisabled ? "disabled" : ""}>打开会话</button>
        <button class="btn-action" data-action="toggle-send" ${controlsDisabled || isParent ? "disabled" : ""}>追问/指令</button>
        <button class="btn-action" data-action="view-result" data-msg-id="${msg}" ${controlsDisabled || !item.messageId ? "disabled" : ""}>查看结果</button>
        <button class="btn-action danger" data-action="cancel" data-msg-id="${msg}" ${controlsDisabled || !canCancel ? "disabled" : ""}>中止</button>
        <button class="btn-action" data-action="accept" data-msg-id="${msg}" ${controlsDisabled || !canAccept ? "disabled" : ""}>验收</button>`);
      card.querySelector("[data-send-box]").hidden = !state.expandedSends.has(item.sessionId);
      const submit = card.querySelector('[data-action="submit-send"]');
      submit.disabled = controlsDisabled || !state.parentSessionId || state.parentBusy || isParent;
      submit.textContent = pending ? "提交中..." : "提交追问";
      // Do not move the focused card: moving a DOM node can lose caret/IME state.
      if (!card.parentNode) container.appendChild(card);
      else if (orderChanged && !editing) container.appendChild(card);
    }
    updateConnection();
  }
  function renderModelSelect() {
    const select = $("selectModel");
    const value = select.value;
    select.innerHTML = '<option value="">自动选择可委派模型</option>';
    for (const model of state.models) {
      const option = document.createElement("option");
      option.value = model.key;
      option.disabled = !model.availableForSubagents && !model.isDefault;
      option.textContent = `${model.alias || model.label || model.key}${model.availableForSubagents ? " · 可委派" : model.isDefault ? " · 默认" : " · 未启用委派"}`;
      select.appendChild(option);
    }
    select.value = value;
  }
  function applyData(result) {
    state.sessions = result.sessions || [];
    state.workers = result.workers || [];
    state.recent = result.recent || [];
    state.parentSessionId = result.parentSessionId || null;
    state.parentBusy = Boolean(result.parentBusy);
    state.connected = true;
    if (result.models) { state.models = result.models; state.defaultModel = result.defaultModel; renderModelSelect(); }
    if (state.errorSource !== "action") {
      $("errorNotice").hidden = true;
      state.errorSource = null;
    }
    renderList();
  }
  async function refreshData(silent = false, initialize = false) {
    if (state.refreshing) return state.refreshing;
    state.refreshing = (async () => {
      try {
        if (!silent) {
          state.errorSource = null;
          $("errorNotice").hidden = true;
        }
        const result = await invoke(initialize || !state.models.length ? "orchestrator.init" : "orchestrator.list");
        applyData(result);
        if (result.modelError) {
          state.errorSource = "model";
          $("errorNotice").textContent = result.modelError;
          $("errorNotice").hidden = false;
        }
        return true;
      } catch (error) {
        state.connected = false;
        showError(error, "sync");
        renderList();
        if (!silent) showToast(`同步失败：${error.message}`, "error");
        return false;
      } finally { state.refreshing = null; }
    })();
    return state.refreshing;
  }
  function stopPolling() { clearTimeout(state.pollTimer); state.pollTimer = null; }
  function startPolling() {
    stopPolling();
    if (!state.polling) return;
    state.pollTimer = setTimeout(async () => {
      if (!document.hidden) await refreshData(true);
      startPolling();
    }, 3000);
  }
  function showSubmission(result) {
    if (!result.submitted || !result.turnId) throw new Error("宿主没有返回主会话提交回执");
    state.errorSource = null;
    $("errorNotice").hidden = true;
    $("submissionNotice").textContent = `已提交给主会话 ${result.parentSessionId.slice(0, 8)}（轮次 ${result.turnId.slice(0, 8)}）。等待主会话调用 SessionTask；本回执不代表子任务已派发。`;
    $("submissionNotice").hidden = false;
    showToast("已提交主会话，请查看其真实派发回执");
  }
  async function submitSpawn(event) {
    event.preventDefault();
    if (state.isSpawning || !state.connected || !state.parentSessionId || state.parentBusy) return;
    const payload = {
      task: $("inputTask").value.trim(), title: $("inputTitle").value.trim(), model: $("selectModel").value,
      notifyOnCompletion: $("chkNotify").checked, parentSessionId: state.parentSessionId
    };
    if (!payload.task) return showToast("请输入任务内容", "error");
    const holder = { request: state.spawnRequest };
    payload.requestId = requestFor(holder, JSON.stringify(payload));
    state.spawnRequest = holder.request;
    state.isSpawning = true;
    updateConnection();
    $("btnSubmitSpawn").textContent = "正在提交主会话...";
    try {
      showSubmission(await invoke("orchestrator.spawn", payload));
      $("spawnForm").reset(); state.spawnRequest = null;
      $("spawnDrawer").hidden = true;
      await refreshData(true);
    } catch (error) { showError(error); showToast(`提交失败：${error.message}；草稿已保留`, "error"); }
    finally {
      state.isSpawning = false;
      $("btnSubmitSpawn").textContent = "提交给主会话派发";
      updateConnection();
    }
  }
  async function submitSend(sessionId) {
    if (state.pending.has(sessionId) || !state.connected || !state.parentSessionId || state.parentBusy) return;
    if (sessionId === state.parentSessionId) return showToast("不能向当前主会话自身发送协作追问", "error");
    const draft = draftFor(sessionId);
    const message = draft.message.trim();
    if (!message) return showToast("请输入追问内容", "error");
    const payload = { sessionId, message, kind: draft.kind, parentSessionId: state.parentSessionId, notifyOnCompletion: false };
    payload.requestId = requestFor(draft, JSON.stringify(payload));
    state.pending.add(sessionId); renderList();
    try {
      showSubmission(await invoke("orchestrator.send", payload));
      // Preserve edits made while admission was in progress.
      if (draft.message.trim() === message && draft.kind === payload.kind) {
        state.drafts.delete(sessionId); state.expandedSends.delete(sessionId);
        const card = state.cards.get(sessionId);
        if (card) { card.querySelector("[data-send-input]").value = ""; card.querySelector("[data-send-kind]").value = "task"; }
      }
      await refreshData(true);
    } catch (error) { showError(error); showToast(`提交失败：${error.message}；草稿已保留`, "error"); }
    finally { state.pending.delete(sessionId); renderList(); }
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); showToast("已复制"); }
    catch { showToast("复制失败，请选择面板文本后按 Ctrl+C", "error"); }
  }
  async function openResultModal(sessionId, messageId) {
    if (!messageId) return showToast("暂无明确投递 ID，请刷新状态", "error");
    const token = ++state.modalRequest;
    $("resultModal").hidden = false;
    $("modalTitle").textContent = `执行结果 · ${sessionId.slice(0, 8)}`;
    $("modalMeta").textContent = `会话 ${sessionId} · 投递 ${messageId}`;
    $("modalContent").textContent = "正在查询这次投递...";
    try {
      const result = await invoke("orchestrator.result", { sessionId, messageId });
      if (token !== state.modalRequest) return;
      const message = result.message || {};
      $("modalMeta").textContent = `会话 ${sessionId} · 投递 ${messageId} · ${(STATUSES[message.status] || STATUSES.unknown)[1]}`;
      $("modalContent").textContent = message.result || message.error || (result.ready ? "本次投递没有最终报告。" : "本次投递尚未结束。请稍后重新查询。\n" + JSON.stringify(result, null, 2));
    } catch (error) { if (token === state.modalRequest) $("modalContent").textContent = `查询失败：${error.message}`; }
  }
  function openAction(action, sessionId, messageId) {
    if (!messageId) return showToast("缺少投递 ID，不能执行此操作", "error");
    state.action = { action, sessionId, messageId };
    $("actionTitle").textContent = action === "cancel" ? "中止这次投递" : "记录本次交付验收";
    $("actionDescription").textContent = `会话：${sessionId}\n投递：${messageId}\n${action === "cancel" ? "仅中止所选投递，不删除会话。" : "请先查阅报告；只记录本次投递的验收，不验收后续任务。"}`;
    $("actionNote").value = "";
    $("actionNote").hidden = $("actionNoteLabel").hidden = action === "cancel";
    $("btnConfirmAction").disabled = false;
    $("actionModal").hidden = false;
  }
  async function confirmAction(event) {
    event.preventDefault();
    const selected = state.action;
    if (!selected || state.pending.has(selected.sessionId)) return;
    state.pending.add(selected.sessionId); $("btnConfirmAction").disabled = true; renderList();
    try {
      await invoke(`orchestrator.${selected.action}`, { ...selected, note: $("actionNote").value.trim() });
      $("actionModal").hidden = true; state.action = null;
      showToast(selected.action === "cancel" ? "宿主已处理取消请求" : "本次投递的验收记录已保存");
      await refreshData(true);
    } catch (error) { showError(error); showToast(error.message, "error"); }
    finally { state.pending.delete(selected.sessionId); $("btnConfirmAction").disabled = false; renderList(); }
  }
  function setupEvents() {
    $("btnRefresh").addEventListener("click", async () => { if (await refreshData(false, true)) showToast("已同步真实会话状态"); });
    $("btnTogglePoll").addEventListener("click", () => {
      state.polling = !state.polling;
      $("btnTogglePoll").classList.toggle("active", state.polling);
      $("txtPollStatus").textContent = state.polling ? "轮询中(3s)" : "轮询已暂停";
      state.polling ? startPolling() : stopPolling();
    });
    $("btnOpenSpawn").addEventListener("click", () => { $("spawnDrawer").hidden = !$("spawnDrawer").hidden; if (!$("spawnDrawer").hidden) $("inputTask").focus(); });
    $("btnCloseSpawn").addEventListener("click", () => { $("spawnDrawer").hidden = true; });
    $("spawnForm").addEventListener("submit", submitSpawn);
    $("inputSearch").addEventListener("input", event => { state.search = event.target.value.trim().toLowerCase(); renderList(); });
    for (const button of document.querySelectorAll(".tab-pill, .stat-pill")) button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab || button.dataset.filter || "all";
      for (const tab of document.querySelectorAll(".tab-pill")) tab.classList.toggle("active", tab.dataset.tab === state.activeTab);
      renderList();
    });
    const list = $("sessionsList");
    list.addEventListener("input", event => {
      const card = event.target.closest(".session-card");
      if (card && event.target.matches("[data-send-input]")) draftFor(card.dataset.sessionId).message = event.target.value;
    });
    list.addEventListener("change", event => {
      const card = event.target.closest(".session-card");
      if (card && event.target.matches("[data-send-kind]")) draftFor(card.dataset.sessionId).kind = event.target.value;
    });
    list.addEventListener("click", async event => {
      const button = event.target.closest("[data-action]");
      const card = button?.closest(".session-card");
      if (!card || button.disabled) return;
      const sessionId = card.dataset.sessionId;
      const messageId = button.dataset.msgId;
      try {
        switch (button.dataset.action) {
          case "copy-id": return copyText(sessionId);
          case "toggle-send":
            if (sessionId === state.parentSessionId) return;
            state.expandedSends.has(sessionId) ? state.expandedSends.delete(sessionId) : state.expandedSends.add(sessionId);
            renderList(); if (state.expandedSends.has(sessionId)) card.querySelector("[data-send-input]").focus(); break;
          case "close-send": state.expandedSends.delete(sessionId); renderList(); break;
          case "submit-send": return submitSend(sessionId);
          case "view-result": return openResultModal(sessionId, messageId);
          case "cancel": case "accept": return openAction(button.dataset.action, sessionId, messageId);
          case "open": await invoke("orchestrator.open", { sessionId }); break;
        }
      } catch (error) { showError(error); }
    });
    for (const id of ["btnCloseModal", "btnCloseModalBtn"]) $(id).addEventListener("click", () => { state.modalRequest++; $("resultModal").hidden = true; });
    $("btnCopyResult").addEventListener("click", () => copyText($("modalContent").textContent));
    $("actionForm").addEventListener("submit", confirmAction);
    $("btnDismissAction").addEventListener("click", () => { $("actionModal").hidden = true; state.action = null; });
    window.pluginBridge?.on?.("session:activated", snapshot => {
      state.parentSessionId = snapshot?.sessionId || null;
      state.parentBusy = Boolean(snapshot?.activeTurn);
      updateConnection();
      renderList();
    });
    window.pluginBridge?.on?.("session:turnEnded", () => refreshData(true));
    window.pluginBridge?.on?.("appearance:changed", applyAppearance);
    window.pluginBridge?.on?.("workspace:changed", () => refreshData(true, true));
    window.pluginBridge?.on?.("view:open", () => refreshData(true, true));
    window.addEventListener("pagehide", stopPolling);
    window.pluginBridge?.invoke?.("app.getAppearance").then(applyAppearance).catch(() => applyAppearance(null));
    if (!window.pluginBridge?.invoke) applyAppearance(null);
  }
  document.addEventListener("DOMContentLoaded", async () => {
    setupEvents(); await refreshData(false, true); startPolling();
  });
})();

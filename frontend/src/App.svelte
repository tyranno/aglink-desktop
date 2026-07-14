<script>
  import { onMount, tick } from "svelte";
  import { Events } from "@wailsio/runtime";
  import { ControlService } from "../bindings/github.com/tyranno/aglink-desktop";

  const WORKER_POLL_MS = 3000;
  const WORKING_GRACE_MS = 30000;
  const STALE_AFTER_MS = 5 * 60 * 1000;

  let connected = $state(false);
  let view = $state("chat");
  let settingsTab = $state("settings");
  let telegram = $state(null);
  let webConvs = $state([]);
  let currentTarget = $state(null);
  let currentMessages = $state([]);
  let composerText = $state("");
  let drafts = $state(new Map());
  let sentHistory = $state([]);
  let historyIndex = $state(0);
  let working = $state(new Map());
  let unread = $state(new Set());
  let loadingBuffers = $state(new Map());
  let statusNote = $state("");
  let versionInfo = $state({});
  let auxInfo = $state({ features: [] });
  let settingsSchema = $state([]);
  let settingsValues = $state({});
  let settingsOriginal = $state({});
  let settingsMsg = $state("");
  let configText = $state("");
  let configMsg = $state("");
  let openMenuId = $state("");
  let attachedFilePath = $state("");
  let attachedFileName = $state("");
  let nowTick = $state(Date.now());
  let promptState = $state(null);
  let confirmState = $state(null);

  let promptResolver = null;
  let confirmResolver = null;
  let textareaEl = $state(null);
  let logEl = $state(null);

  function parseJSON(value, fallback) {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function normalizeTarget(raw) {
    if (!raw) return { kind: "telegram" };
    if (typeof raw === "string") {
      try {
        return normalizeTarget(JSON.parse(raw));
      } catch {
        return { kind: "telegram" };
      }
    }
    return {
      kind: raw.kind || "telegram",
      id: raw.id || "",
      project: raw.project || "",
    };
  }

  function targetKey(target) {
    if (!target || target.kind !== "web") return "telegram";
    return `web:${target.id}`;
  }

  function currentKey() {
    return targetKey(currentTarget);
  }

  function frameTarget(frame) {
    return normalizeTarget(frame?.target);
  }

  function isCurrentTarget(target) {
    return !!currentTarget && currentKey() === targetKey(target);
  }

  function findWebConv(id) {
    return webConvs.find((conv) => conv.id === id) || null;
  }

  function currentConversationMeta() {
    if (!currentTarget) return null;
    if (currentTarget.kind === "telegram") {
      return {
        kind: "telegram",
        title: telegram?.title || "텔레그램",
        id: "telegram",
        workDir: "",
        backend: telegram?.backend || "",
      };
    }
    const conv = findWebConv(currentTarget.id);
    return {
      kind: "web",
      title: conv?.title || currentTarget.title || currentTarget.id,
      id: currentTarget.id,
      workDir: conv?.workDir || "",
      backend: conv?.backend || "",
    };
  }

  function conversationLabel(conv) {
    return conv?.title || conv?.id || "이름 없는 대화";
  }

  function backendLabel(backend) {
    return backend ? String(backend).toUpperCase() : "DEFAULT";
  }

  async function setChannelBackend(target, backend) {
    try {
      const reply = parseJSON(await ControlService.SetChannelBackend(target.kind || "telegram", target.id || "", backend), { ok: false });
      if (!reply.ok) {
        statusNote = `Backend 설정 실패: ${reply.error || "알 수 없는 오류"}`;
        return;
      }
      openMenuId = "";
      await loadConversations({ forceReloadCurrent: false });
    } catch (error) {
      statusNote = `Backend 설정 실패: ${error}`;
    }
  }

  function cloneMessages(messages) {
    return messages.map((message) => ({ ...message }));
  }

  function scrollLogToBottom() {
    if (!logEl) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        logEl.scrollTop = logEl.scrollHeight;
      });
    });
  }

  async function resizeComposer() {
    await tick();
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, 240)}px`;
  }

  function setDraft(key, value) {
    const next = new Map(drafts);
    next.set(key, value);
    drafts = next;
  }

  function clearDraft(key) {
    const next = new Map(drafts);
    next.delete(key);
    drafts = next;
  }

  function rememberSentHistory(text) {
    const item = String(text || "").trim();
    if (!item) return;
    const next = sentHistory[sentHistory.length - 1] === item ? [...sentHistory] : [...sentHistory, item];
    sentHistory = next.slice(-100);
    historyIndex = sentHistory.length;
  }

  async function recallSentHistory(direction, event) {
    if (!textareaEl || sentHistory.length === 0) return false;
    const value = textareaEl.value || "";
    const atStart = textareaEl.selectionStart === 0 && textareaEl.selectionEnd === 0;
    const atEnd = textareaEl.selectionStart === value.length && textareaEl.selectionEnd === value.length;
    if (direction < 0 && value && !atStart) return false;
    if (direction > 0 && value && !atEnd) return false;
    event.preventDefault();
    historyIndex = Math.max(0, Math.min(sentHistory.length, historyIndex + direction));
    composerText = historyIndex < sentHistory.length ? sentHistory[historyIndex] : "";
    if (currentTarget) setDraft(currentKey(), composerText);
    await resizeComposer();
    textareaEl.setSelectionRange(composerText.length, composerText.length);
    return true;
  }

  function setUnread(key, active) {
    const next = new Set(unread);
    if (active) next.add(key);
    else next.delete(key);
    unread = next;
  }

  function startWorking(key) {
    const now = Date.now();
    const next = new Map(working);
    const prev = next.get(key);
    next.set(key, {
      startedAt: prev?.startedAt || now,
      lastAliveAt: now,
    });
    working = next;
  }

  function stopWorking(key) {
    if (!working.has(key)) return;
    const next = new Map(working);
    next.delete(key);
    working = next;
  }

  function currentWorking() {
    return currentTarget ? working.get(currentKey()) : undefined;
  }

  function currentWorkingText() {
    const active = currentWorking();
    if (!active) return "";
    const elapsedSec = Math.max(0, Math.floor((nowTick - active.startedAt) / 1000));
    const elapsed =
      elapsedSec < 60
        ? `${elapsedSec}초`
        : `${Math.floor(elapsedSec / 60)}분 ${elapsedSec % 60}초`;
    if (nowTick - active.lastAliveAt > STALE_AFTER_MS) {
      return `작업 상태 확인이 오래되었습니다 (${elapsed})`;
    }
    return `작업 진행 중 (${elapsed})`;
  }

  function messageFromFrame(frame) {
    if (!frame) return null;
    if (frame.type === "text") {
      return { role: "assistant", text: frame.text || "", image: "" };
    }
    if (frame.type === "image") {
      return {
        role: "assistant",
        text: frame.caption || "",
        image: frame.data || "",
      };
    }
    if (frame.type === "user") {
      return { role: "user", text: frame.text || "", image: "" };
    }
    return null;
  }

  function sameMessage(a, b) {
    return (
      !!a &&
      !!b &&
      a.role === b.role &&
      (a.text || "") === (b.text || "") &&
      (a.image || "") === (b.image || "")
    );
  }

  function pushMessage(message) {
    if (!message) return;
    const last = currentMessages[currentMessages.length - 1];
    if (sameMessage(last, message)) return;
    currentMessages = [...currentMessages, message];
    scrollLogToBottom();
  }

  function appendLiveFrame(frame) {
    const message = messageFromFrame(frame);
    if (message) pushMessage(message);
  }

  function bufferFrame(key, frame) {
    if (!loadingBuffers.has(key)) return false;
    const next = new Map(loadingBuffers);
    const pending = [...(next.get(key) || []), frame];
    next.set(key, pending);
    loadingBuffers = next;
    return true;
  }

  function flushBufferedFrames(key, messages) {
    const frames = loadingBuffers.get(key) || [];
    const nextMessages = [...messages];
    for (const frame of frames) {
      const message = messageFromFrame(frame);
      const last = nextMessages[nextMessages.length - 1];
      if (message && !sameMessage(last, message)) nextMessages.push(message);
    }
    const nextBuffers = new Map(loadingBuffers);
    nextBuffers.delete(key);
    loadingBuffers = nextBuffers;
    return nextMessages;
  }

  function applyCurrentDraft() {
    composerText = currentTarget ? drafts.get(currentKey()) || "" : "";
    resizeComposer();
  }

  async function selectTarget(target) {
    const normalized = normalizeTarget(target);
    const key = targetKey(normalized);
    currentTarget = { ...normalized };
    setUnread(key, false);
    openMenuId = "";
    statusNote = "";
    attachedFilePath = "";
    attachedFileName = "";
    currentMessages = [];
    applyCurrentDraft();

    const nextBuffers = new Map(loadingBuffers);
    nextBuffers.set(key, []);
    loadingBuffers = nextBuffers;

    try {
      const raw = await ControlService.GetHistory(normalized.kind, normalized.id || "");
      const data = parseJSON(raw, { turns: [] });
      if (currentKey() !== key) return;
      const history = Array.isArray(data.turns)
        ? data.turns.map((turn) => ({
            role: turn.role || "assistant",
            text: turn.text || "",
            image: turn.image || turn.data || "",
          }))
        : [];
      currentMessages = flushBufferedFrames(key, history);
      await tick();
      scrollLogToBottom();
    } catch (error) {
      if (currentKey() !== key) return;
      const nextLoading = new Map(loadingBuffers);
      nextLoading.delete(key);
      loadingBuffers = nextLoading;
      currentMessages = [{ role: "system", text: `히스토리를 불러오지 못했습니다: ${error}` }];
    }
  }

  function chooseFallbackTarget(data) {
    const activeWeb = (data.webConvs || []).find((conv) => conv.active);
    if (activeWeb) return { kind: "web", id: activeWeb.id };
    if ((data.webConvs || []).length > 0) return { kind: "web", id: data.webConvs[0].id };
    if (data.telegram) return { kind: "telegram" };
    return null;
  }

  function syncCurrentTarget(data) {
    if (!currentTarget) return chooseFallbackTarget(data);
    if (currentTarget.kind === "telegram") {
      return data.telegram ? currentTarget : chooseFallbackTarget(data);
    }
    const existing = (data.webConvs || []).find((conv) => conv.id === currentTarget.id);
    if (!existing) return chooseFallbackTarget(data);
    return { kind: "web", id: existing.id };
  }

  async function loadConversations(options = {}) {
    try {
      const raw = await ControlService.ListConversations();
      const data = parseJSON(raw, {});
      telegram = data.telegram || null;
      webConvs = Array.isArray(data.webConvs) ? data.webConvs : [];

      const nextTarget = syncCurrentTarget(data);
      if (!nextTarget) {
        currentTarget = null;
        currentMessages = [];
        composerText = "";
        return;
      }

      if (
        options.forceReloadCurrent ||
        !currentTarget ||
        targetKey(nextTarget) !== currentKey()
      ) {
        await selectTarget(nextTarget);
      } else {
        currentTarget = { ...currentTarget, ...nextTarget };
      }
    } catch (error) {
      statusNote = `대화 목록을 불러오지 못했습니다: ${error}`;
    }
  }

  async function loadVersionInfo() {
    try {
      versionInfo = parseJSON(await ControlService.GetVersion(), {});
    } catch {
      versionInfo = {};
    }
  }

  async function loadAuxInfo() {
    try {
      auxInfo = parseJSON(await ControlService.GetAux(), { features: [] });
    } catch {
      auxInfo = { features: [] };
    }
  }

  async function loadSettingsSchema() {
    settingsMsg = "";
    try {
      const data = parseJSON(await ControlService.GetSettings(), { sections: [] });
      settingsSchema = Array.isArray(data.sections) ? data.sections : [];
      const nextValues = {};
      for (const section of settingsSchema) {
        for (const field of section.fields || []) {
          nextValues[field.key] = field.value;
        }
      }
      settingsValues = nextValues;
      settingsOriginal = { ...nextValues };
    } catch (error) {
      settingsSchema = [];
      settingsMsg = `설정을 불러오지 못했습니다: ${error}`;
    }
  }

  async function loadRawConfig() {
    configMsg = "";
    try {
      const data = parseJSON(await ControlService.GetConfig(), { config: "", error: "" });
      if (data.error) {
        configMsg = data.error;
        configText = "";
        return;
      }
      configText = data.config || "";
    } catch (error) {
      configMsg = `raw config를 불러오지 못했습니다: ${error}`;
      configText = "";
    }
  }

  async function loadSettingsTab(tab) {
    settingsTab = tab;
    if (tab === "settings") {
      await Promise.all([loadSettingsSchema(), loadRawConfig()]);
      return;
    }
    await Promise.all([loadVersionInfo(), loadAuxInfo()]);
  }

  async function openSettings(tab) {
    view = "settings";
    await loadSettingsTab(tab);
  }

  async function backToChat() {
    view = "chat";
    await tick();
    scrollLogToBottom();
  }

  function updateSettingValue(key, value) {
    settingsValues = { ...settingsValues, [key]: value };
  }

  async function saveSettings() {
    const updates = {};
    for (const [key, value] of Object.entries(settingsValues)) {
      if (String(value) !== String(settingsOriginal[key])) updates[key] = value;
    }
    if (Object.keys(updates).length === 0) {
      settingsMsg = "변경된 항목이 없습니다.";
      return;
    }
    settingsMsg = "저장 중...";
    try {
      const reply = parseJSON(
        await ControlService.SetSettings(JSON.stringify(updates)),
        { ok: false, error: "unknown error" },
      );
      if (reply.ok) {
        settingsMsg = "저장했습니다. 필요한 경우 서비스 재시작이 필요할 수 있습니다.";
        await loadSettingsSchema();
      } else {
        settingsMsg = `저장 실패: ${reply.error || "알 수 없는 오류"}`;
      }
    } catch (error) {
      settingsMsg = `저장 실패: ${error}`;
    }
  }

  async function saveRawConfig() {
    configMsg = "저장 중...";
    try {
      const reply = parseJSON(
        await ControlService.SetConfig(configText),
        { ok: false, error: "unknown error" },
      );
      configMsg = reply.ok ? "raw config를 저장했습니다." : `저장 실패: ${reply.error || "알 수 없는 오류"}`;
    } catch (error) {
      configMsg = `저장 실패: ${error}`;
    }
  }

  async function pollWorkers(force = false) {
    if (!force && working.size === 0) return;
    try {
      const data = parseJSON(await ControlService.GetActiveWorkers(), { workers: [] });
      const activeKeys = new Set(
        (data.workers || []).map((worker) =>
          worker.conversationId === "telegram" ? "telegram" : `web:${worker.conversationId}`,
        ),
      );

      let next = new Map(working);
      let changed = false;
      const now = Date.now();

      for (const key of activeKeys) {
        if (!next.has(key)) {
          next.set(key, { startedAt: now, lastAliveAt: now });
          changed = true;
        }
      }

      for (const [key, entry] of [...next.entries()]) {
        if (!activeKeys.has(key) && now - entry.startedAt > WORKING_GRACE_MS) {
          next.delete(key);
          changed = true;
        }
      }

      if (changed) working = next;
    } catch {
      // Leave current state untouched while the control API is unavailable.
    }
  }

  function setComposerValue(value) {
    composerText = value;
    if (currentTarget) setDraft(currentKey(), value);
    resizeComposer();
  }

  function clearComposer() {
    composerText = "";
    if (currentTarget) clearDraft(currentKey());
    resizeComposer();
  }

  function canSend() {
    return !!currentTarget && !!composerText.trim() && connected && !currentWorking();
  }

  async function sendCurrent() {
    if (!currentTarget) return;
    const key = currentKey();
    const caption = composerText.trim();

    if (attachedFilePath) {
      pushMessage({
        role: "user",
        text: caption ? `[첨부] ${attachedFileName}\n${caption}` : `[첨부] ${attachedFileName}`,
        image: "",
      });
      startWorking(key);
      clearComposer();
      const filePath = attachedFilePath;
      attachedFilePath = "";
      attachedFileName = "";
      try {
        await ControlService.UploadAttachment(filePath, caption, currentTarget.kind, currentTarget.id || "");
      } catch (error) {
        pushMessage({ role: "system", text: `첨부 업로드 실패: ${error}` });
        stopWorking(key);
      }
      return;
    }

    if (!canSend()) return;
    pushMessage({ role: "user", text: caption, image: "" });
    startWorking(key);
    rememberSentHistory(caption);
    clearComposer();
    try {
      await ControlService.SendText(caption, currentTarget.kind, currentTarget.id || "");
      void loadConversations();
    } catch (error) {
      pushMessage({ role: "system", text: `전송 실패: ${error}` });
      stopWorking(key);
    }
  }

  async function newWebConversation() {
    const title = await askText("새 웹 대화", "선택 사항: 제목", "");
    if (title === null) return;
    try {
      await ControlService.WebNew(title.trim());
      await loadConversations({ forceReloadCurrent: true });
      if (webConvs[0]) await selectTarget({ kind: "web", id: webConvs[0].id });
    } catch (error) {
      statusNote = `새 대화를 만들지 못했습니다: ${error}`;
    }
  }

  async function renameWebConversation(conv) {
    const nextTitle = await askText("이름 변경", "새 대화 이름", conv.title || "");
    if (nextTitle === null) return;
    try {
      await ControlService.WebRename(conv.id, nextTitle.trim());
      await loadConversations({ forceReloadCurrent: currentTarget?.id === conv.id });
    } catch (error) {
      statusNote = `이름 변경 실패: ${error}`;
    }
  }

  async function changeWebDirectory(conv) {
    try {
      const dir = await ControlService.PickFolder();
      if (!dir) return;
      await ControlService.WebSetDir(conv.id, dir);
      await loadConversations({ forceReloadCurrent: currentTarget?.id === conv.id });
    } catch (error) {
      statusNote = `작업 폴더 변경 실패: ${error}`;
    }
  }

  async function deleteWebConversation(conv) {
    const confirmed = await askConfirm(
      "대화 삭제",
      `"${conversationLabel(conv)}" 대화를 삭제하시겠습니까?`,
      "삭제",
    );
    if (!confirmed) return;
    try {
      const wasCurrent = currentTarget?.kind === "web" && currentTarget.id === conv.id;
      await ControlService.WebDelete(conv.id);
      const key = `web:${conv.id}`;
      setUnread(key, false);
      stopWorking(key);
      clearDraft(key);
      if (wasCurrent) {
        currentTarget = null;
        currentMessages = [];
        composerText = "";
      }
      await loadConversations({ forceReloadCurrent: true });
    } catch (error) {
      statusNote = `대화 삭제 실패: ${error}`;
    }
  }

  async function pickAttachment() {
    try {
      const path = await ControlService.PickFile();
      if (!path) return;
      attachedFilePath = path;
      attachedFileName = path.split(/[/\\]/).pop() || path;
    } catch (error) {
      statusNote = `첨부 파일 선택 실패: ${error}`;
    }
  }

  function clearAttachment() {
    attachedFilePath = "";
    attachedFileName = "";
  }

  function handleComposerKeydown(event) {
    if (event.key === "ArrowUp") {
      void recallSentHistory(-1, event);
      return;
    }
    if (event.key === "ArrowDown") {
      void recallSentHistory(1, event);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendCurrent();
    }
  }

  function handleFrame(frame) {
    const target = frameTarget(frame);
    const key = targetKey(target);

    if (frame.type === "typing") startWorking(key);
    if (frame.type === "done") stopWorking(key);

    if (!isCurrentTarget(target)) {
      if (frame.type === "text" || frame.type === "image" || frame.type === "user") {
        setUnread(key, true);
      }
      return;
    }

    if (bufferFrame(key, frame)) return;
    appendLiveFrame(frame);
  }

  function askText(title, label, initialValue) {
    return new Promise((resolve) => {
      promptResolver = resolve;
      promptState = { title, label, value: initialValue || "" };
    });
  }

  function resolvePrompt(result) {
    const resolver = promptResolver;
    promptResolver = null;
    promptState = null;
    resolver?.(result);
  }

  function askConfirm(title, message, confirmLabel = "확인") {
    return new Promise((resolve) => {
      confirmResolver = resolve;
      confirmState = { title, message, confirmLabel };
    });
  }

  function resolveConfirm(result) {
    const resolver = confirmResolver;
    confirmResolver = null;
    confirmState = null;
    resolver?.(result);
  }

  function versionBadgeText() {
    const version = versionInfo.version || "?";
    return versionInfo.updateAvailable ? `${version} 업데이트 가능` : version;
  }

  function backendBadgeText() {
    return versionInfo.backend || telegram?.backend || "";
  }

  function auxStateTone(state) {
    if (state === "running") return "bg-emerald-100 text-emerald-700";
    if (state === "idle") return "bg-slate-200 text-slate-600";
    return "bg-rose-100 text-rose-700";
  }

  onMount(() => {
    void Promise.all([loadConversations(), loadVersionInfo(), pollWorkers(true)]);
    ControlService.Connected()
      .then((value) => {
        connected = value;
      })
      .catch(() => {});

    const offStatus = Events.On("control:status", (event) => {
      connected = !!event.data;
      if (connected) {
        void Promise.all([loadConversations({ forceReloadCurrent: true }), loadVersionInfo(), pollWorkers(true)]);
        if (view === "settings" && settingsTab === "connection") void loadAuxInfo();
      } else {
        working = new Map();
      }
    });

    const offFrame = Events.On("frame", (event) => {
      handleFrame(event.data || {});
    });

    const tickTimer = window.setInterval(() => {
      nowTick = Date.now();
    }, 1000);

    const workerTimer = window.setInterval(() => {
      void pollWorkers();
    }, WORKER_POLL_MS);

    const clickAway = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.closest("[data-conv-menu]")) openMenuId = "";
    };

    const onEscape = (event) => {
      if (event.key !== "Escape") return;
      if (promptState) resolvePrompt(null);
      if (confirmState) resolveConfirm(false);
      openMenuId = "";
    };

    document.addEventListener("click", clickAway);
    document.addEventListener("keydown", onEscape);

    resizeComposer();

    return () => {
      offStatus();
      offFrame();
      window.clearInterval(tickTimer);
      window.clearInterval(workerTimer);
      document.removeEventListener("click", clickAway);
      document.removeEventListener("keydown", onEscape);
    };
  });
</script>

<div class="flex h-full min-h-0 w-full overflow-hidden text-[13px] text-slate-900">
  <div class="flex h-full w-full flex-col overflow-hidden">
    <header class="flex h-12 shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-900 px-3 text-white shadow-sm">
      <span class={`inline-flex shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold ${connected ? "bg-emerald-500 text-white" : "bg-rose-500 text-white"}`}>
        {connected ? "연결됨" : "연결 끊김"}
      </span>
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold">teleclaude</div>
      </div>
      {#if backendBadgeText()}
        <span class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-2 py-1 text-[11px] font-semibold capitalize text-slate-100" title="현재 연결된 백엔드">
          <span class={`h-1.5 w-1.5 rounded-full ${backendBadgeText() === "codex" ? "bg-emerald-400" : "bg-orange-300"}`}></span>
          {backendBadgeText()}
        </span>
      {/if}
      <span class={`inline-flex shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ${versionInfo.updateAvailable ? "bg-amber-300 text-amber-950" : "bg-white/10 text-slate-100"}`} title="실행 중인 버전">
        {versionBadgeText()}
      </span>
      <div class="ml-auto flex items-center gap-2">
        <button
          class="grid h-8 w-8 place-items-center rounded-md border border-white/20 bg-white/5 text-sm text-slate-100 hover:bg-white/10"
          onclick={() => openSettings("settings")}
          title="설정"
          aria-label="설정"
        >
          ⚙
        </button>
        <button
          class="grid h-8 w-8 place-items-center rounded-md border border-white/20 bg-white/5 text-sm text-slate-100 hover:bg-white/10"
          onclick={() => openSettings("connection")}
          title="연결 / aglink"
          aria-label="연결 / aglink"
        >
          🔌
        </button>
      </div>
    </header>

    {#if view === "chat"}
      <div class="flex min-h-0 flex-1 overflow-hidden">
        <aside class="flex h-full w-[296px] shrink-0 flex-col border-r border-slate-200 bg-slate-50/90 backdrop-blur">
          <div class="flex h-11 shrink-0 items-center gap-2 border-b border-slate-200 px-3">
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-semibold text-slate-900">대화 목록</div>
            </div>
            <button
              class="grid h-8 w-8 place-items-center rounded-md border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-100"
              onclick={() => loadConversations({ forceReloadCurrent: true })}
              title="대화 목록 새로고침"
              aria-label="대화 목록 새로고침"
            >
              ↻
            </button>
            <button
              class="grid h-8 w-8 place-items-center rounded-md bg-blue-600 text-base font-semibold text-white hover:bg-blue-700"
              onclick={newWebConversation}
              title="새 대화"
              aria-label="새 대화"
            >
              ＋
            </button>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <div class="mb-4">
              <div class="mb-2 px-1 text-[11px] font-bold tracking-[0.04em] text-slate-500">텔레그램 채널</div>
              <div class="border-l-2 border-slate-200 pl-2">
                {#if telegram}
                  <div
                    class={`relative flex h-9 w-full items-center gap-1 rounded-md px-1.5 transition ${currentTarget?.kind === "telegram" ? "bg-blue-50 text-blue-950 ring-1 ring-blue-200" : "hover:bg-slate-100"}`}
                    data-conv-menu
                  >
                    <button
                      class="min-w-0 flex flex-1 items-center gap-2 rounded px-1.5 py-1 text-left transition hover:bg-slate-100/70"
                      onclick={() => selectTarget({ kind: "telegram" })}
                      title={telegram.title || "텔레그램"}
                    >
                      <span class="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-sky-500"></span>
                      <span class="min-w-0 flex-1 truncate text-sm font-semibold">
                        {telegram.title || "텔레그램"}
                      </span>
                      <span class="shrink-0 rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">{backendLabel(telegram.backend)}</span>
                      {#if unread.has("telegram")}
                        <span class="shrink-0 rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">NEW</span>
                      {/if}
                    </button>
                    <button
                      class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-slate-200 bg-white/80 text-base leading-none text-slate-600 hover:bg-slate-100"
                      onclick={() => (openMenuId = openMenuId === "telegram" ? "" : "telegram")}
                      title="채널 설정"
                      aria-label="채널 설정"
                    >
                      ⋯
                    </button>
                    {#if openMenuId === "telegram"}
                      <div class="absolute right-0 top-8 z-20 w-40 rounded-lg border border-slate-200 bg-white p-1.5 shadow-xl">
                        <div class="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">AI backend</div>
                        <button class="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100" onclick={() => setChannelBackend({ kind: "telegram" }, "default")}>Default</button>
                        <button class="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100" onclick={() => setChannelBackend({ kind: "telegram" }, "claude")}>Claude</button>
                        <button class="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100" onclick={() => setChannelBackend({ kind: "telegram" }, "codex")}>Codex</button>
                      </div>
                    {/if}
                  </div>
                {:else}
                  <div class="rounded-md px-2 py-3 text-sm text-slate-500">텔레그램 대화를 찾지 못했습니다.</div>
                {/if}
              </div>
            </div>

            <div>
              <div class="mb-2 px-1 text-[11px] font-bold tracking-[0.04em] text-slate-500">웹 채널</div>
              <div class="space-y-1 border-l-2 border-slate-200 pl-2">
                {#if webConvs.length === 0}
                  <div class="rounded-md border border-dashed border-slate-300 bg-white/70 px-3 py-4 text-sm text-slate-500">
                    아직 웹 대화가 없습니다. "새 대화"로 시작하세요.
                  </div>
                {/if}

                {#each webConvs as conv (conv.id)}
                  <div
                    class={`relative flex h-10 items-center gap-1 rounded-md border px-1.5 shadow-sm ${currentTarget?.kind === "web" && currentTarget.id === conv.id ? "border-blue-200 bg-blue-50 text-blue-950" : "border-slate-200 bg-white/85 text-slate-900"}`}
                    data-conv-menu
                    title={conv.workDir ? `${conversationLabel(conv)} · ${conv.workDir}` : conversationLabel(conv)}
                  >
                      <button
                        class="min-w-0 flex flex-1 items-center gap-2 rounded px-1.5 py-1 text-left transition hover:bg-slate-100/70"
                        onclick={() => selectTarget({ kind: "web", id: conv.id })}
                      >
                        <span class="min-w-0 flex-1 truncate text-sm font-semibold">{conversationLabel(conv)}</span>
                        <span class="shrink-0 font-mono text-[11px] text-slate-400">#{conv.id}</span>
                        <span class="shrink-0 rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">{backendLabel(conv.backend)}</span>
                        {#if currentTarget?.kind === "web" && currentTarget.id === conv.id}
                          <span class="shrink-0 rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">현재</span>
                        {/if}
                        {#if unread.has(`web:${conv.id}`)}
                          <span class="shrink-0 rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">NEW</span>
                        {/if}
                      </button>

                      <button
                        class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-slate-200 bg-white/80 text-base leading-none text-slate-600 hover:bg-slate-100"
                        onclick={() => (openMenuId = openMenuId === conv.id ? "" : conv.id)}
                        title="대화 관리"
                        aria-label="대화 관리"
                      >
                        ⋯
                      </button>

                      {#if openMenuId === conv.id}
                        <div class="absolute right-0 top-9 z-20 w-48 rounded-lg border border-slate-200 bg-white p-1.5 shadow-xl">
                          <div class="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">AI backend</div>
                          <button class="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100" onclick={() => setChannelBackend({ kind: "web", id: conv.id }, "default")}>Default</button>
                          <button class="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100" onclick={() => setChannelBackend({ kind: "web", id: conv.id }, "claude")}>Claude</button>
                          <button class="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100" onclick={() => setChannelBackend({ kind: "web", id: conv.id }, "codex")}>Codex</button>
                          <div class="my-1 h-px bg-slate-100"></div>
                          <button class="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100" onclick={() => { openMenuId = ""; renameWebConversation(conv); }}>
                            이름 변경
                          </button>
                          <button class="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100" onclick={() => { openMenuId = ""; changeWebDirectory(conv); }}>
                            작업 폴더 변경
                          </button>
                          <button class="block w-full rounded-md px-3 py-2 text-left text-sm text-rose-700 hover:bg-rose-50" onclick={() => { openMenuId = ""; deleteWebConversation(conv); }}>
                            삭제
                          </button>
                        </div>
                      {/if}
                  </div>
                {/each}
              </div>
            </div>
          </div>
        </aside>

        <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div class="flex h-10 shrink-0 items-center gap-2 border-b border-slate-200 bg-white/75 px-4 backdrop-blur">
            {#if currentConversationMeta()}
              <span class={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${currentConversationMeta().kind === "web" ? "bg-blue-100 text-blue-700" : "bg-sky-100 text-sky-700"}`}>
                {currentConversationMeta().kind === "web" ? "웹" : "텔레그램"}
              </span>
              <div class="flex min-w-0 flex-1 items-center gap-2">
                <div class="min-w-0 truncate text-sm font-semibold text-slate-900">{currentConversationMeta().title}</div>
                <span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600">#{currentConversationMeta().id}</span>
                <span class="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-700">{backendLabel(currentConversationMeta().backend)}</span>
                {#if currentConversationMeta().workDir}
                  <span class="min-w-0 truncate rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">{currentConversationMeta().workDir}</span>
                {:else if currentConversationMeta().kind === "web"}
                  <span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">작업 폴더 미지정</span>
                {/if}
              </div>
            {:else}
              <div class="text-sm text-slate-500">대화를 선택하세요.</div>
            {/if}
          </div>

          {#if statusNote}
            <div class="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">{statusNote}</div>
          {/if}

          <div bind:this={logEl} class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
            <div class="flex min-h-full w-full flex-col gap-2">
              {#if currentMessages.length === 0}
                <div class="rounded-lg border border-dashed border-slate-300 bg-white/60 px-6 py-10 text-center text-sm text-slate-500">
                  메시지가 없습니다. 첫 요청을 보내 보세요.
                </div>
              {/if}

              {#each currentMessages as message, index (`${index}-${message.role}-${message.text}-${message.image}`)}
                <div class={`flex w-full ${message.role === "user" ? "justify-end" : message.role === "system" ? "justify-center" : "justify-start"}`}>
                  <div class={`min-w-0 max-w-[92%] overflow-hidden rounded-lg px-3 py-1.5 shadow-sm ring-1 ${
                    message.role === "user"
                      ? "bg-blue-600 text-white ring-blue-500/40"
                      : message.role === "system"
                        ? "bg-amber-50 text-amber-900 ring-amber-200"
                        : "bg-white/95 text-slate-900 ring-slate-200"
                  }`}>
                    {#if message.text}
                      <div class="whitespace-pre-wrap break-words text-[13px] leading-4">{message.text}</div>
                    {/if}
                    {#if message.image}
                      <img
                        alt=""
                        class={`mt-2 max-h-[420px] w-auto max-w-full rounded-lg border ${message.role === "user" ? "border-white/30" : "border-slate-200"}`}
                        src={`data:image/png;base64,${message.image}`}
                      />
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </div>

          {#if currentWorking()}
            <div class="flex shrink-0 items-center gap-3 border-t border-slate-200/80 bg-white/80 px-4 py-2 text-xs text-slate-600 backdrop-blur">
              <div class="flex items-center gap-1.5">
                <span class="h-2 w-2 animate-pulse rounded-full bg-blue-500"></span>
                <span class="h-2 w-2 animate-pulse rounded-full bg-blue-400 [animation-delay:150ms]"></span>
                <span class="h-2 w-2 animate-pulse rounded-full bg-blue-300 [animation-delay:300ms]"></span>
              </div>
              <span>{currentWorkingText()}</span>
            </div>
          {/if}

          <div class="shrink-0 border-t border-slate-200/80 bg-white/92 px-4 py-3 backdrop-blur">
            {#if attachedFilePath}
              <div class="mb-3 flex w-full items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                <span class="rounded-full bg-emerald-100 px-2 py-1 font-semibold">첨부</span>
                <span class="min-w-0 flex-1 truncate">{attachedFileName}</span>
                <button
                  class="grid h-7 w-7 place-items-center rounded-md border border-emerald-200 bg-white text-[11px] font-medium text-emerald-700 hover:bg-emerald-100"
                  onclick={clearAttachment}
                  title="첨부 제거"
                  aria-label="첨부 제거"
                >
                  ✕
                </button>
              </div>
            {/if}

            <div class="flex w-full items-end gap-3">
              <button
                class="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-md border border-slate-300 bg-white text-base text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                onclick={pickAttachment}
                disabled={!currentTarget}
                title="파일 첨부"
                aria-label="파일 첨부"
              >
                📎
              </button>

              <textarea
                bind:this={textareaEl}
                class="min-h-[42px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm leading-5 text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-100 disabled:bg-slate-100"
                placeholder={currentTarget ? "메시지 또는 !명령을 입력하세요" : "먼저 대화를 선택하세요"}
                value={composerText}
                disabled={!currentTarget}
                rows="1"
                oninput={(event) => setComposerValue(event.currentTarget.value)}
                onkeydown={handleComposerKeydown}
              ></textarea>

              <button
                class="grid h-[42px] w-[46px] shrink-0 place-items-center rounded-md bg-blue-600 text-base font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                onclick={sendCurrent}
                disabled={(!attachedFilePath && !canSend()) || !connected}
                title={attachedFilePath ? "업로드" : "전송"}
                aria-label={attachedFilePath ? "업로드" : "전송"}
              >
                {attachedFilePath ? "⇪" : "➤"}
              </button>
            </div>
          </div>
        </main>
      </div>
    {:else}
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="flex h-11 shrink-0 items-center gap-3 border-b border-slate-200/80 bg-white/75 px-4 backdrop-blur">
          <button
            class="grid h-8 w-8 place-items-center rounded-md border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-100"
            onclick={backToChat}
            title="채팅으로"
            aria-label="채팅으로"
          >
            ←
          </button>
          <div class="text-sm font-semibold text-slate-900">설정</div>
          <div class="ml-auto flex gap-2">
            <button
              class={`rounded-full px-3 py-2 text-xs font-semibold ${settingsTab === "settings" ? "bg-blue-600 text-white" : "border border-slate-300 bg-white text-slate-700"}`}
              onclick={() => loadSettingsTab("settings")}
            >
              설정
            </button>
            <button
              class={`rounded-full px-3 py-2 text-xs font-semibold ${settingsTab === "connection" ? "bg-blue-600 text-white" : "border border-slate-300 bg-white text-slate-700"}`}
              onclick={() => loadSettingsTab("connection")}
            >
              연결 / aglink
            </button>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div class="mx-auto flex w-full max-w-5xl flex-col gap-5">
            {#if settingsTab === "settings"}
              <section class="rounded-lg border border-slate-200 bg-white/90 p-5 shadow-sm">
                <div class="mb-5">
                  <div class="text-sm font-semibold text-slate-900">구조화 설정</div>
                  <div class="mt-1 text-xs text-slate-500">bool, select, int, text 타입을 그대로 편집합니다.</div>
                </div>

                {#if settingsSchema.length === 0}
                  <div class="rounded-lg border border-dashed border-slate-300 px-4 py-5 text-sm text-slate-500">
                    {settingsMsg || "표시할 설정이 없습니다."}
                  </div>
                {:else}
                  <div class="space-y-6">
                    {#each settingsSchema as section}
                      <div>
                        <div class="mb-3 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">{section.title}</div>
                        <div class="space-y-3">
                          {#each section.fields || [] as field}
                            <div class="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                              <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                                <div class="min-w-0 md:max-w-[60%]">
                                  <div class="text-sm font-semibold text-slate-900">{field.label}</div>
                                  {#if field.desc}
                                    <div class="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-slate-500">{field.desc}</div>
                                  {/if}
                                </div>
                                <div class="md:min-w-[220px]">
                                  {#if field.type === "bool"}
                                    <label class="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                                      <input
                                        class="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                        type="checkbox"
                                        checked={!!settingsValues[field.key]}
                                        onchange={(event) => updateSettingValue(field.key, event.currentTarget.checked)}
                                      />
                                      사용
                                    </label>
                                  {:else if field.type === "select"}
                                    <select
                                      class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
                                      value={settingsValues[field.key] ?? ""}
                                      onchange={(event) => updateSettingValue(field.key, event.currentTarget.value)}
                                    >
                                      {#each field.options || [] as option}
                                        <option value={option}>{option}</option>
                                      {/each}
                                    </select>
                                  {:else}
                                    <input
                                      class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
                                      type={field.type === "int" ? "number" : "text"}
                                      value={settingsValues[field.key] ?? ""}
                                      oninput={(event) =>
                                        updateSettingValue(
                                          field.key,
                                          field.type === "int"
                                            ? event.currentTarget.value === ""
                                              ? 0
                                              : Number(event.currentTarget.value)
                                            : event.currentTarget.value,
                                        )}
                                    />
                                  {/if}
                                </div>
                              </div>
                            </div>
                          {/each}
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}

                <div class="mt-5 flex items-center gap-3">
                  <button class="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700" onclick={saveSettings}>
                    설정 저장
                  </button>
                  {#if settingsMsg}
                    <span class="text-xs text-slate-500">{settingsMsg}</span>
                  {/if}
                </div>
              </section>

              <section class="rounded-lg border border-slate-200 bg-white/90 p-5 shadow-sm">
                <div class="mb-5">
                  <div class="text-sm font-semibold text-slate-900">raw config</div>
                  <div class="mt-1 text-xs text-slate-500">`get_config` / `set_config` 응답 형식에 맞춰 원문을 직접 수정합니다.</div>
                </div>
                <textarea
                  class="min-h-[320px] w-full rounded-lg border border-slate-300 bg-slate-950 px-4 py-3 font-mono text-[12px] leading-6 text-slate-100 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
                  spellcheck="false"
                  value={configText}
                  oninput={(event) => (configText = event.currentTarget.value)}
                ></textarea>
                <div class="mt-4 flex items-center gap-3">
                  <button class="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800" onclick={saveRawConfig}>
                    raw 저장
                  </button>
                  {#if configMsg}
                    <span class="text-xs text-slate-500">{configMsg}</span>
                  {/if}
                </div>
              </section>
            {:else}
              <section class="rounded-lg border border-slate-200 bg-white/90 p-5 shadow-sm">
                <div class="mb-5">
                  <div class="text-sm font-semibold text-slate-900">버전 / 백엔드</div>
                  <div class="mt-1 text-xs text-slate-500">웹판의 `/api/status`, `/api/version`, `/api/aux` 정보를 데스크톱 상태와 함께 요약합니다.</div>
                </div>

                <div class="grid gap-4 md:grid-cols-2">
                  <div class="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                    <div class="mb-3 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">teleclaude</div>
                    <div class="space-y-2 text-sm text-slate-700">
                      <div class="flex items-center justify-between gap-3">
                        <span>현재 백엔드</span>
                        <span class="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">{backendBadgeText() || "-"}</span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span>실행 버전</span>
                        <span class="font-mono text-xs text-slate-600">{versionInfo.version || "-"}</span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span>최신 버전</span>
                        <span class="font-mono text-xs text-slate-600">{versionInfo.latestVersion || "-"}</span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span>업데이트 상태</span>
                        <span class={`rounded-full px-2.5 py-1 text-xs font-semibold ${versionInfo.updateAvailable ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-700"}`}>
                          {versionInfo.updateAvailable ? "업데이트 필요" : "최신"}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div class="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                    <div class="mb-3 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">desktop control</div>
                    <div class="space-y-2 text-sm text-slate-700">
                      <div class="flex items-center justify-between gap-3">
                        <span>연결 상태</span>
                        <span class={`rounded-full px-2.5 py-1 text-xs font-semibold ${connected ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                          {connected ? "connected" : "disconnected"}
                        </span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span>running commit</span>
                        <span class="truncate font-mono text-xs text-slate-600">{versionInfo.commit || "-"}</span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span>latest commit</span>
                        <span class="truncate font-mono text-xs text-slate-600">{versionInfo.latestCommit || "-"}</span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span>build time</span>
                        <span class="truncate font-mono text-xs text-slate-600">{versionInfo.buildTime || "-"}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="mt-6">
                  <div class="mb-3 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">aglink 보조 기능</div>
                  <div class="space-y-3">
                    {#if (auxInfo.features || []).length === 0}
                      <div class="rounded-lg border border-dashed border-slate-300 px-4 py-4 text-sm text-slate-500">
                        get_aux 응답이 비어 있습니다.
                      </div>
                    {:else}
                      {#each auxInfo.features || [] as feature}
                        <div class="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                          <div class="flex flex-wrap items-center gap-3">
                            <div class="min-w-0 flex-1">
                              <div class="text-sm font-semibold text-slate-900">
                                {feature.label}{#if feature.version} <span class="font-mono text-xs text-slate-500">({feature.version})</span>{/if}
                              </div>
                              {#if feature.detail}
                                <div class="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-slate-500">{feature.detail}</div>
                              {/if}
                            </div>
                            <span class={`rounded-full px-2.5 py-1 text-xs font-semibold ${auxStateTone(feature.state)}`}>
                              {feature.state || "unknown"}
                            </span>
                          </div>
                        </div>
                      {/each}
                    {/if}
                  </div>
                </div>
              </section>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

{#if promptState}
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/35 px-4">
    <div class="w-full max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-2xl">
      <div class="text-lg font-semibold text-slate-900">{promptState.title}</div>
      {#if promptState.label}
        <div class="mt-2 text-sm text-slate-500">{promptState.label}</div>
      {/if}
      <input
        class="mt-4 w-full rounded-md border border-slate-300 px-4 py-3 text-sm outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
        value={promptState.value}
        oninput={(event) => (promptState = { ...promptState, value: event.currentTarget.value })}
        onkeydown={(event) => {
          if (event.key === "Enter") resolvePrompt(promptState.value);
        }}
      />
      <div class="mt-5 flex justify-end gap-2">
        <button class="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" onclick={() => resolvePrompt(null)}>
          취소
        </button>
        <button class="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700" onclick={() => resolvePrompt(promptState.value)}>
          확인
        </button>
      </div>
    </div>
  </div>
{/if}

{#if confirmState}
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/35 px-4">
    <div class="w-full max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-2xl">
      <div class="text-lg font-semibold text-slate-900">{confirmState.title}</div>
      <div class="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{confirmState.message}</div>
      <div class="mt-5 flex justify-end gap-2">
        <button class="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" onclick={() => resolveConfirm(false)}>
          취소
        </button>
        <button class="rounded-md bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700" onclick={() => resolveConfirm(true)}>
          {confirmState.confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}

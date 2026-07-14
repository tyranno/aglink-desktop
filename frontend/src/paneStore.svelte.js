import { tick } from "svelte";
import { ControlService } from "../bindings/github.com/tyranno/aglink-desktop";

export const MAX_PANES = 4;
export const MIN_PANE_PERCENT = 15;
export const WORKING_GRACE_MS = 30000;
export const STALE_AFTER_MS = 5 * 60 * 1000;

export const SLASH_COMMANDS = [
  { cmd: "!project", desc: "프로젝트 등록/삭제/목록 (add|remove|list)" },
  { cmd: "!chat", desc: "대화 생성/목록/전환 (new|list|use)" },
  { cmd: "!status", desc: "실행 중 작업 + 활성 대화 + 백엔드" },
  { cmd: "!cancel", desc: "진행 중 작업 취소" },
  { cmd: "!parallel", desc: "여러 프롬프트를 동시에 실행 (p1 | p2 | ...)" },
  { cmd: "!task", desc: "예약 작업/알림 (add|once|list|pause|resume|cancel|update|help)" },
  { cmd: "!history", desc: "대화 기록 조회 (list)" },
  { cmd: "!compact", desc: "지금까지 대화 요약 저장 후 세션 새로 시작" },
  { cmd: "!user", desc: "허용 사용자 관리 (add|remove|list)" },
  { cmd: "!screen", desc: "화면 제어 (list|shot|region|preset|click)" },
  { cmd: "!remind", desc: "일회성 알림 (구버전 호환)" },
  { cmd: "!cron", desc: "반복 작업 (구버전 호환)" },
  { cmd: "!backend", desc: "AI 백엔드 전환 (claude|codex)" },
  { cmd: "!update", desc: "새 버전 빌드 & 자동 재시작" },
  { cmd: "!help", desc: "이 도움말" },
];

export const chat = $state({
  connected: false,
  telegram: null,
  webConvs: [],
  panes: [
    { id: "pane-0", target: null, attachments: [], composerText: "", commandMenuHidden: false, highlightedCommandIndex: 0 },
  ],
  layout: { type: "leaf", paneId: "pane-0" },
  focusedPaneId: "pane-0",
  messagesByKey: new Map(),
  drafts: new Map(),
  sentHistory: [],
  historyIndex: 0,
  working: new Map(),
  unread: new Set(),
  loadingBuffers: new Map(),
  statusNote: "",
  nowTick: Date.now(),
  draggingPaneId: null,
  draggingConversation: null,
  overPaneId: null,
  overZone: null,
});

let attachmentSeq = 0;
let paneSeq = 1;
let layoutSeq = 0;
export const paneTextareas = new Map();
export const paneLogs = new Map();

export function registerPaneTextarea(node, paneId) {
  paneTextareas.set(paneId, node);
  return {
    destroy() {
      if (paneTextareas.get(paneId) === node) paneTextareas.delete(paneId);
    },
  };
}

export function registerPaneLog(node, paneId) {
  paneLogs.set(paneId, node);
  return {
    destroy() {
      if (paneLogs.get(paneId) === node) paneLogs.delete(paneId);
    },
  };
}

export function parseJSON(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function normalizeTarget(raw) {
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

export function targetKey(target) {
  if (!target || target.kind !== "web") return "telegram";
  return `web:${target.id}`;
}

export function frameTarget(frame) {
  return normalizeTarget(frame?.target);
}

export function findWebConv(id) {
  return chat.webConvs.find((conv) => conv.id === id) || null;
}

export function backendLabel(backend) {
  return backend ? String(backend).toUpperCase() : "DEFAULT";
}

// ---- layout tree (leaf | split) ----

function makeSplitId() {
  return `split-${layoutSeq++}`;
}

export function collectLeafIds(node, out = []) {
  if (node.type === "leaf") {
    out.push(node.paneId);
    return out;
  }
  for (const child of node.children) collectLeafIds(child.node, out);
  return out;
}

function findSplitNode(node, splitId) {
  if (node.type === "leaf") return null;
  if (node.id === splitId) return node;
  for (const child of node.children) {
    const found = findSplitNode(child.node, splitId);
    if (found) return found;
  }
  return null;
}

function removeLeaf(node, paneId) {
  if (node.type === "leaf") {
    return node.paneId === paneId ? { node: null, removed: true } : { node, removed: false };
  }
  let removed = false;
  const nextChildren = [];
  for (const child of node.children) {
    if (removed) {
      nextChildren.push(child);
      continue;
    }
    const result = removeLeaf(child.node, paneId);
    if (!result.removed) {
      nextChildren.push(child);
      continue;
    }
    removed = true;
    if (result.node) nextChildren.push({ size: child.size, node: result.node });
  }
  if (!removed) return { node, removed: false };
  if (nextChildren.length === 0) return { node: null, removed: true };
  if (nextChildren.length === 1) return { node: nextChildren[0].node, removed: true };
  const evenSize = 100 / nextChildren.length;
  return { node: { ...node, children: nextChildren.map((c) => ({ ...c, size: evenSize })) }, removed: true };
}

function insertAtEdge(node, targetPaneId, newPaneId, edge) {
  if (node.type === "leaf") {
    if (node.paneId !== targetPaneId) return node;
    const direction = edge === "top" || edge === "bottom" ? "column" : "row";
    const newLeaf = { type: "leaf", paneId: newPaneId };
    const targetLeaf = { type: "leaf", paneId: targetPaneId };
    const children =
      edge === "top" || edge === "left"
        ? [{ size: 50, node: newLeaf }, { size: 50, node: targetLeaf }]
        : [{ size: 50, node: targetLeaf }, { size: 50, node: newLeaf }];
    return { type: "split", id: makeSplitId(), direction, children };
  }
  return {
    ...node,
    children: node.children.map((child) => ({ ...child, node: insertAtEdge(child.node, targetPaneId, newPaneId, edge) })),
  };
}

function swapLeaves(node, paneIdA, paneIdB) {
  if (node.type === "leaf") {
    if (node.paneId === paneIdA) return { ...node, paneId: paneIdB };
    if (node.paneId === paneIdB) return { ...node, paneId: paneIdA };
    return node;
  }
  return { ...node, children: node.children.map((child) => ({ ...child, node: swapLeaves(child.node, paneIdA, paneIdB) })) };
}

function resizeSplitChildren(node, splitId, index, leftSize, rightSize) {
  if (node.type === "leaf") return node;
  if (node.id === splitId) {
    return {
      ...node,
      children: node.children.map((child, i) => {
        if (i === index) return { ...child, size: leftSize };
        if (i === index + 1) return { ...child, size: rightSize };
        return child;
      }),
    };
  }
  return {
    ...node,
    children: node.children.map((child) => ({ ...child, node: resizeSplitChildren(child.node, splitId, index, leftSize, rightSize) })),
  };
}

// ---- pane lifecycle ----

export function pane(paneId) {
  return chat.panes.find((item) => item.id === paneId) || null;
}

export function focusedPane() {
  return pane(chat.focusedPaneId) || chat.panes[0] || null;
}

export function updatePane(paneId, patch) {
  chat.panes = chat.panes.map((item) => (item.id === paneId ? { ...item, ...patch } : item));
}

export function focusPane(paneId) {
  if (chat.focusedPaneId !== paneId) chat.focusedPaneId = paneId;
}

export function addPane() {
  if (chat.panes.length >= MAX_PANES) return;
  const id = `pane-${paneSeq++}`;
  chat.panes = [
    ...chat.panes,
    { id, target: null, attachments: [], composerText: "", commandMenuHidden: false, highlightedCommandIndex: 0 },
  ];
  const targetId = chat.focusedPaneId || chat.panes[0]?.id;
  chat.layout = insertAtEdge(chat.layout, targetId, id, "right");
  chat.focusedPaneId = id;
}

export function closePane(paneId) {
  if (chat.panes.length <= 1) return;
  const closing = pane(paneId);
  if (closing) for (const attachment of closing.attachments) revokeAttachmentPreview(attachment);
  paneTextareas.delete(paneId);
  paneLogs.delete(paneId);
  const result = removeLeaf(chat.layout, paneId);
  if (result.node) chat.layout = result.node;
  chat.panes = chat.panes.filter((item) => item.id !== paneId);
  if (chat.focusedPaneId === paneId) {
    const remainingIds = collectLeafIds(chat.layout);
    chat.focusedPaneId = remainingIds[0] || chat.panes[0]?.id || "";
  }
}

export function startSplitResize(event, splitId, direction, childIndex) {
  const container = event.currentTarget.parentElement;
  if (!container) return;
  event.preventDefault();
  const splitNode = findSplitNode(chat.layout, splitId);
  if (!splitNode) return;
  const leftChild = splitNode.children[childIndex - 1];
  const rightChild = splitNode.children[childIndex];
  if (!leftChild || !rightChild) return;

  const rect = container.getBoundingClientRect();
  const containerSize = direction === "column" ? rect.height : rect.width;
  const startPos = direction === "column" ? event.clientY : event.clientX;
  const startLeftSize = leftChild.size;
  const startRightSize = rightChild.size;
  const pairTotal = startLeftSize + startRightSize;

  document.body.style.cursor = direction === "column" ? "row-resize" : "col-resize";
  document.body.style.userSelect = "none";

  function onMove(moveEvent) {
    const pos = direction === "column" ? moveEvent.clientY : moveEvent.clientX;
    const deltaPercent = containerSize > 0 ? ((pos - startPos) / containerSize) * 100 : 0;
    let nextLeft = startLeftSize + deltaPercent;
    let nextRight = startRightSize - deltaPercent;
    if (nextLeft < MIN_PANE_PERCENT) {
      nextLeft = MIN_PANE_PERCENT;
      nextRight = pairTotal - nextLeft;
    } else if (nextRight < MIN_PANE_PERCENT) {
      nextRight = MIN_PANE_PERCENT;
      nextLeft = pairTotal - nextRight;
    }
    chat.layout = resizeSplitChildren(chat.layout, splitId, childIndex - 1, nextLeft, nextRight);
  }

  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

// ---- drag-to-dock ----

export function handlePaneDragStart(event, paneId) {
  chat.draggingPaneId = paneId;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", paneId);
}

export function handlePaneDragEnd() {
  chat.draggingPaneId = null;
  chat.overPaneId = null;
  chat.overZone = null;
}

export function handleConversationDragStart(event, target) {
  chat.draggingConversation = normalizeTarget(target);
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("text/plain", JSON.stringify(target));
}

export function handleConversationDragEnd() {
  chat.draggingConversation = null;
  chat.overPaneId = null;
  chat.overZone = null;
}

function zoneFromEvent(event, rect) {
  const x = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
  const y = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
  if (x < 0.25) return "left";
  if (x > 0.75) return "right";
  if (y < 0.25) return "top";
  if (y > 0.75) return "bottom";
  return "center";
}

export function handlePaneDragOver(event, paneId) {
  if (!chat.draggingPaneId && !chat.draggingConversation) return;
  if (chat.draggingPaneId === paneId) return;
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  chat.overPaneId = paneId;
  chat.overZone = zoneFromEvent(event, rect);
}

export function handlePaneDragLeave(paneId) {
  if (chat.overPaneId === paneId) {
    chat.overPaneId = null;
    chat.overZone = null;
  }
}

export function dockPane(draggedId, targetId, zone) {
  if (zone === "center") {
    chat.layout = swapLeaves(chat.layout, draggedId, targetId);
    chat.focusedPaneId = draggedId;
    return;
  }
  const afterRemoval = removeLeaf(chat.layout, draggedId);
  if (!afterRemoval.node) return;
  chat.layout = insertAtEdge(afterRemoval.node, targetId, draggedId, zone);
  chat.focusedPaneId = draggedId;
}

export function dockConversation(target, targetPaneId, zone) {
  if (!zone || zone === "center" || chat.panes.length >= MAX_PANES) {
    if (zone && zone !== "center" && chat.panes.length >= MAX_PANES) {
      chat.statusNote = `패널이 최대 ${MAX_PANES}개라 새 분할 대신 이 패널에 불러옵니다.`;
    }
    chat.focusedPaneId = targetPaneId;
    void selectTargetInPane(targetPaneId, target);
    return;
  }
  const id = `pane-${paneSeq++}`;
  chat.panes = [
    ...chat.panes,
    { id, target: null, attachments: [], composerText: "", commandMenuHidden: false, highlightedCommandIndex: 0 },
  ];
  chat.layout = insertAtEdge(chat.layout, targetPaneId, id, zone);
  chat.focusedPaneId = id;
  void selectTargetInPane(id, target);
}

export function handlePaneDrop(event, paneId) {
  event.preventDefault();
  const draggedId = chat.draggingPaneId;
  const draggedConversation = chat.draggingConversation;
  const zone = chat.overZone;
  chat.draggingPaneId = null;
  chat.draggingConversation = null;
  chat.overPaneId = null;
  chat.overZone = null;

  if (draggedConversation) {
    dockConversation(draggedConversation, paneId, zone);
    return;
  }
  if (!draggedId || draggedId === paneId || !zone) return;
  dockPane(draggedId, paneId, zone);
}

// ---- pane content helpers ----

export function paneConversationMeta(target) {
  if (!target) return null;
  if (target.kind === "telegram") {
    return {
      kind: "telegram",
      title: chat.telegram?.title || "텔레그램",
      id: "telegram",
      workDir: "",
      backend: chat.telegram?.backend || "",
    };
  }
  const conv = findWebConv(target.id);
  return {
    kind: "web",
    title: conv?.title || target.title || target.id,
    id: target.id,
    workDir: conv?.workDir || "",
    backend: conv?.backend || "",
  };
}

export function scrollPaneLogToBottom(paneId) {
  const el = paneLogs.get(paneId);
  if (!el) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  });
}

export async function resizePaneComposer(paneId) {
  await tick();
  const el = paneTextareas.get(paneId);
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
}

export function setDraft(key, value) {
  const next = new Map(chat.drafts);
  next.set(key, value);
  chat.drafts = next;
}

export function clearDraft(key) {
  const next = new Map(chat.drafts);
  next.delete(key);
  chat.drafts = next;
}

export function rememberSentHistory(text) {
  const item = String(text || "").trim();
  if (!item) return;
  const next = chat.sentHistory[chat.sentHistory.length - 1] === item ? [...chat.sentHistory] : [...chat.sentHistory, item];
  chat.sentHistory = next.slice(-100);
  chat.historyIndex = chat.sentHistory.length;
}

export async function recallSentHistoryForPane(paneId, direction, event) {
  const el = paneTextareas.get(paneId);
  if (!el || chat.sentHistory.length === 0) return false;
  const value = el.value || "";
  const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
  const atEnd = el.selectionStart === value.length && el.selectionEnd === value.length;
  if (direction < 0 && value && !atStart) return false;
  if (direction > 0 && value && !atEnd) return false;
  event.preventDefault();
  chat.historyIndex = Math.max(0, Math.min(chat.sentHistory.length, chat.historyIndex + direction));
  const nextValue = chat.historyIndex < chat.sentHistory.length ? chat.sentHistory[chat.historyIndex] : "";
  setPaneComposerValue(paneId, nextValue);
  await tick();
  el.setSelectionRange(nextValue.length, nextValue.length);
  return true;
}

export function setUnread(key, active) {
  const next = new Set(chat.unread);
  if (active) next.add(key);
  else next.delete(key);
  chat.unread = next;
}

export function startWorking(key) {
  const now = Date.now();
  const next = new Map(chat.working);
  const prev = next.get(key);
  next.set(key, {
    startedAt: prev?.startedAt || now,
    lastAliveAt: now,
  });
  chat.working = next;
}

export function stopWorking(key) {
  if (!chat.working.has(key)) return;
  const next = new Map(chat.working);
  next.delete(key);
  chat.working = next;
}

export function paneWorking(target) {
  return target ? chat.working.get(targetKey(target)) : undefined;
}

export function paneWorkingText(target) {
  const active = paneWorking(target);
  if (!active) return "";
  const elapsedSec = Math.max(0, Math.floor((chat.nowTick - active.startedAt) / 1000));
  const elapsed =
    elapsedSec < 60
      ? `${elapsedSec}초`
      : `${Math.floor(elapsedSec / 60)}분 ${elapsedSec % 60}초`;
  if (chat.nowTick - active.lastAliveAt > STALE_AFTER_MS) {
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

export function messagesForPane(target) {
  if (!target) return [];
  return chat.messagesByKey.get(targetKey(target)) || [];
}

export function pushMessageToKey(key, message) {
  if (!message) return;
  const current = chat.messagesByKey.get(key) || [];
  const last = current[current.length - 1];
  if (sameMessage(last, message)) return;
  chat.messagesByKey = new Map(chat.messagesByKey).set(key, [...current, message]);
  for (const item of chat.panes) {
    if (item.target && targetKey(item.target) === key) scrollPaneLogToBottom(item.id);
  }
}

function appendLiveFrameToKey(key, frame) {
  const message = messageFromFrame(frame);
  if (message) pushMessageToKey(key, message);
}

export function bufferFrame(key, frame) {
  if (!chat.loadingBuffers.has(key)) return false;
  const next = new Map(chat.loadingBuffers);
  const pending = [...(next.get(key) || []), frame];
  next.set(key, pending);
  chat.loadingBuffers = next;
  return true;
}

export function flushBufferedFrames(key, messages) {
  const frames = chat.loadingBuffers.get(key) || [];
  const nextMessages = [...messages];
  for (const frame of frames) {
    const message = messageFromFrame(frame);
    const last = nextMessages[nextMessages.length - 1];
    if (message && !sameMessage(last, message)) nextMessages.push(message);
  }
  const nextBuffers = new Map(chat.loadingBuffers);
  nextBuffers.delete(key);
  chat.loadingBuffers = nextBuffers;
  return nextMessages;
}

export function applyDraftToPane(paneId, key) {
  updatePane(paneId, { composerText: chat.drafts.get(key) || "" });
  resizePaneComposer(paneId);
}

export async function selectTargetInPane(paneId, rawTarget) {
  const normalized = normalizeTarget(rawTarget);
  const key = targetKey(normalized);
  clearPaneAttachments(paneId);
  updatePane(paneId, { target: { ...normalized }, commandMenuHidden: false, highlightedCommandIndex: 0 });
  setUnread(key, false);
  chat.statusNote = "";
  applyDraftToPane(paneId, key);

  const nextBuffers = new Map(chat.loadingBuffers);
  nextBuffers.set(key, []);
  chat.loadingBuffers = nextBuffers;
  chat.messagesByKey = new Map(chat.messagesByKey).set(key, []);

  try {
    const raw = await ControlService.GetHistory(normalized.kind, normalized.id || "");
    const data = parseJSON(raw, { turns: [] });
    const history = Array.isArray(data.turns)
      ? data.turns.map((turn) => ({
          role: turn.role || "assistant",
          text: turn.text || "",
          image: turn.image || turn.data || "",
        }))
      : [];
    const flushed = flushBufferedFrames(key, history);
    chat.messagesByKey = new Map(chat.messagesByKey).set(key, flushed);
    await tick();
    scrollPaneLogToBottom(paneId);
  } catch (error) {
    const nextLoading = new Map(chat.loadingBuffers);
    nextLoading.delete(key);
    chat.loadingBuffers = nextLoading;
    chat.messagesByKey = new Map(chat.messagesByKey).set(key, [{ role: "system", text: `히스토리를 불러오지 못했습니다: ${error}` }]);
  }
}

export function selectTargetFromSidebar(target) {
  const active = focusedPane();
  if (!active) return;
  void selectTargetInPane(active.id, target);
}

export function isFocusedTarget(target) {
  const active = focusedPane();
  if (!active?.target) return false;
  return targetKey(active.target) === targetKey(normalizeTarget(target));
}

export function isTargetVisibleAnywhere(key) {
  return chat.panes.some((item) => item.target && targetKey(item.target) === key);
}

export function chooseFallbackTarget(data) {
  const activeWeb = (data.webConvs || []).find((conv) => conv.active);
  if (activeWeb) return { kind: "web", id: activeWeb.id };
  if ((data.webConvs || []).length > 0) return { kind: "web", id: data.webConvs[0].id };
  if (data.telegram) return { kind: "telegram" };
  return null;
}

function syncPaneTarget(target, data) {
  if (target.kind === "telegram") {
    return data.telegram ? target : chooseFallbackTarget(data);
  }
  const existing = (data.webConvs || []).find((conv) => conv.id === target.id);
  if (!existing) return chooseFallbackTarget(data);
  return { kind: "web", id: existing.id };
}

export async function loadConversations(options = {}) {
  try {
    const raw = await ControlService.ListConversations();
    const data = parseJSON(raw, {});
    chat.telegram = data.telegram || null;
    chat.webConvs = Array.isArray(data.webConvs) ? data.webConvs : [];

    for (const item of chat.panes) {
      if (!item.target) {
        if (chat.panes.length === 1) {
          const fallback = chooseFallbackTarget(data);
          if (fallback) await selectTargetInPane(item.id, fallback);
        }
        continue;
      }
      const nextTarget = syncPaneTarget(item.target, data);
      if (!nextTarget) {
        updatePane(item.id, { target: null });
        continue;
      }
      if (options.forceReloadCurrent || targetKey(nextTarget) !== targetKey(item.target)) {
        await selectTargetInPane(item.id, nextTarget);
      } else {
        updatePane(item.id, { target: { ...item.target, ...nextTarget } });
      }
    }
  } catch (error) {
    chat.statusNote = `대화 목록을 불러오지 못했습니다: ${error}`;
  }
}

export function setPaneComposerValue(paneId, value) {
  const p = pane(paneId);
  updatePane(paneId, { composerText: value, commandMenuHidden: false, highlightedCommandIndex: 0 });
  if (p?.target) setDraft(targetKey(p.target), value);
  resizePaneComposer(paneId);
}

export async function selectCommandForPane(paneId, command) {
  if (!command) return;
  setPaneComposerValue(paneId, `${command.cmd} `);
  await tick();
  const el = paneTextareas.get(paneId);
  el?.focus();
  el?.setSelectionRange(el.value.length, el.value.length);
}

export function clearPaneComposer(paneId) {
  const p = pane(paneId);
  updatePane(paneId, { composerText: "" });
  if (p?.target) clearDraft(targetKey(p.target));
  resizePaneComposer(paneId);
}

export function canSendPane(p) {
  return !!p.target && !!p.composerText.trim() && chat.connected && !paneWorking(p.target);
}

export function commandCandidatesForPane(p) {
  const text = p.composerText;
  if (!text.startsWith("!") || /\s/.test(text)) return [];
  const query = text.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.cmd.slice(1).toLowerCase().startsWith(query));
}

export function showCommandMenuForPane(p) {
  return commandCandidatesForPane(p).length > 0 && !p.commandMenuHidden;
}

export async function sendFromPane(paneId) {
  const p = pane(paneId);
  if (!p?.target) return;
  const key = targetKey(p.target);
  const caption = p.composerText.trim();

  if (p.attachments.length > 0) {
    const pendingAttachments = p.attachments;
    const attachmentNames = pendingAttachments.map((attachment) => attachment.name).join(", ");
    pushMessageToKey(key, {
      role: "user",
      text: caption ? `[첨부] ${attachmentNames}\n${caption}` : `[첨부] ${attachmentNames}`,
      image: "",
    });
    startWorking(key);
    clearPaneComposer(paneId);
    clearPaneAttachments(paneId);
    try {
      for (const attachment of pendingAttachments) {
        await ControlService.UploadAttachment(attachment.path, caption, p.target.kind, p.target.id || "");
      }
    } catch (error) {
      pushMessageToKey(key, { role: "system", text: `첨부 업로드 실패: ${error}` });
      stopWorking(key);
    }
    return;
  }

  if (!canSendPane(p)) return;
  pushMessageToKey(key, { role: "user", text: caption, image: "" });
  startWorking(key);
  rememberSentHistory(caption);
  clearPaneComposer(paneId);
  try {
    await ControlService.SendText(caption, p.target.kind, p.target.id || "");
    void loadConversations();
  } catch (error) {
    pushMessageToKey(key, { role: "system", text: `전송 실패: ${error}` });
    stopWorking(key);
  }
}

export async function pickAttachment(paneId) {
  try {
    const sourcePath = await ControlService.PickFile();
    if (!sourcePath) return;
    const name = sourcePath.split(/[/\\]/).pop() || sourcePath;
    let previewURL = "";
    try {
      previewURL = await ControlService.PreviewAttachmentImage(sourcePath);
    } catch {
      previewURL = "";
    }
    const path = await ControlService.StageAttachment(sourcePath);
    appendPaneAttachment(paneId, { path, name, previewURL });
  } catch (error) {
    chat.statusNote = `첨부 파일 선택 실패: ${error}`;
  }
}

export function revokeAttachmentPreview(attachment) {
  if (attachment?.previewIsObjectURL && attachment.previewURL) {
    URL.revokeObjectURL(attachment.previewURL);
  }
}

export function appendPaneAttachment(paneId, { path, name, previewURL = "", previewIsObjectURL = false }) {
  const p = pane(paneId);
  if (!p) return;
  updatePane(paneId, {
    attachments: [
      ...p.attachments,
      { id: `${Date.now()}-${attachmentSeq++}`, path, name, previewURL, previewIsObjectURL },
    ],
  });
}

export function clearPaneAttachment(paneId, index) {
  const p = pane(paneId);
  if (!p) return;
  const attachment = p.attachments[index];
  revokeAttachmentPreview(attachment);
  updatePane(paneId, { attachments: p.attachments.filter((_, itemIndex) => itemIndex !== index) });
}

export function clearPaneAttachments(paneId) {
  const p = pane(paneId);
  if (!p) return;
  for (const attachment of p.attachments) revokeAttachmentPreview(attachment);
  updatePane(paneId, { attachments: [] });
}

function clipboardImageExtension(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/bmp") return "bmp";
  if (normalized === "image/svg+xml") return "svg";
  return "png";
}

function pastedImageName(file) {
  if (file?.name) return file.name;
  return `pasted-image.${clipboardImageExtension(file?.type)}`;
}

function imageFilesFromClipboard(event) {
  const items = event.clipboardData?.items || [];
  const files = [];
  for (const item of items) {
    if (item.type && item.type.indexOf("image/") === 0) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("failed to read clipboard image"));
    reader.readAsDataURL(file);
  });
}

export async function handleComposerPaste(paneId, event) {
  const p = pane(paneId);
  if (!p?.target) return;
  const files = imageFilesFromClipboard(event);
  if (files.length === 0) return;

  event.preventDefault();
  try {
    for (const file of files) {
      const dataURL = await readFileAsDataURL(file);
      const path = await ControlService.SaveClipboardImage(dataURL);
      appendPaneAttachment(paneId, {
        path,
        name: pastedImageName(file),
        previewURL: URL.createObjectURL(file),
        previewIsObjectURL: true,
      });
    }
    chat.statusNote = "";
  } catch (error) {
    chat.statusNote = `Clipboard image paste failed: ${error}`;
  }
}

export function handleComposerKeydown(paneId, event) {
  const p = pane(paneId);
  if (!p) return;
  const candidates = commandCandidatesForPane(p);
  if (candidates.length > 0 && !p.commandMenuHidden) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      updatePane(paneId, { highlightedCommandIndex: Math.min(p.highlightedCommandIndex + 1, candidates.length - 1) });
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      updatePane(paneId, { highlightedCommandIndex: Math.max(p.highlightedCommandIndex - 1, 0) });
      return;
    }
    if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      void selectCommandForPane(paneId, candidates[p.highlightedCommandIndex] || candidates[0]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      updatePane(paneId, { commandMenuHidden: true });
      return;
    }
  }
  if (event.key === "ArrowUp") {
    void recallSentHistoryForPane(paneId, -1, event);
    return;
  }
  if (event.key === "ArrowDown") {
    void recallSentHistoryForPane(paneId, 1, event);
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendFromPane(paneId);
  }
}

export function handleFrame(frame) {
  const target = frameTarget(frame);
  const key = targetKey(target);

  if (frame.type === "typing") startWorking(key);
  if (frame.type === "done") stopWorking(key);

  if (!isTargetVisibleAnywhere(key)) {
    if (frame.type === "text" || frame.type === "image" || frame.type === "user") {
      setUnread(key, true);
    }
    return;
  }

  if (bufferFrame(key, frame)) return;
  appendLiveFrameToKey(key, frame);
}

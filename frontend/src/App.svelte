<script>
  import { onMount } from "svelte";
  import { Events } from "@wailsio/runtime";
  import { ControlService } from "../bindings/github.com/tyranno/aglink-desktop";

  let connected = $state(false);
  let telegram = $state(null);
  let webConvs = $state([]);
  let current = $state(null); // { kind, id, title }
  let messages = $state([]);  // { role, text, image? }
  let input = $state("");
  let working = $state(false);

  function isCurrent(kind, id) {
    if (!current) return false;
    if (kind === "web") return current.kind === "web" && current.id === id;
    return current.kind === "telegram";
  }

  async function loadConversations() {
    try {
      const data = JSON.parse(await ControlService.ListConversations());
      telegram = data.telegram || null;
      webConvs = Array.isArray(data.webConvs) ? data.webConvs : [];
      if (!current) {
        const act = webConvs.find((w) => w.active);
        if (act) selectConv({ kind: "web", id: act.id, title: act.title });
        else if (telegram) selectConv({ kind: "telegram", title: telegram.title });
      }
    } catch (e) { console.error("loadConversations", e); }
  }

  async function selectConv(t) {
    current = t;
    messages = [];
    try {
      const data = JSON.parse(await ControlService.GetHistory(t.kind, t.id || ""));
      messages = (data.turns || []).map((turn) => ({ role: turn.role, text: turn.text }));
    } catch (e) { console.error("getHistory", e); }
  }

  async function send() {
    const text = input.trim();
    if (!text || !current) return;
    messages = [...messages, { role: "user", text }];
    input = "";
    working = true;
    try {
      await ControlService.SendText(text, current.kind, current.id || "");
    } catch (e) {
      messages = [...messages, { role: "system", text: "전송 실패: " + e }];
      working = false;
    }
  }

  function onKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  async function newChat() {
    try { await ControlService.WebNew(""); } catch (e) { console.error(e); }
    setTimeout(async () => {
      await loadConversations();
      if (webConvs.length) selectConv({ kind: "web", id: webConvs[0].id, title: webConvs[0].title });
    }, 400);
  }

  async function pickFolder(convId) {
    try {
      const path = await ControlService.PickFolder();
      if (path) { await ControlService.WebSetDir(convId, path); setTimeout(loadConversations, 300); }
    } catch (e) { console.error("pickFolder", e); }
  }

  onMount(() => {
    ControlService.Connected().then((v) => (connected = v)).catch(() => {});
    loadConversations();
    const off1 = Events.On("control:status", (e) => {
      connected = !!e.data;
      if (e.data) loadConversations();
    });
    const off2 = Events.On("frame", (e) => {
      const f = e.data || {};
      if (f.type === "text") messages = [...messages, { role: "assistant", text: f.text }];
      else if (f.type === "image") messages = [...messages, { role: "assistant", image: f.data, text: f.caption || "" }];
      else if (f.type === "user") messages = [...messages, { role: "user", text: f.text }];
      else if (f.type === "typing") working = true;
      else if (f.type === "done") working = false;
    });
    return () => { off1(); off2(); };
  });
</script>

<div class="app">
  <header class="hdr">
    <span class="status" class:on={connected}>{connected ? "연결됨" : "연결 끊김"}</span>
    <span class="title">aglink-chat (desktop)</span>
  </header>
  <div class="body">
    <aside class="side">
      <div class="side-head">
        <span>대화</span>
        <button onclick={newChat} title="새 대화">＋</button>
      </div>
      {#if telegram}
        <button class="conv" class:active={isCurrent("telegram")}
                onclick={() => selectConv({ kind: "telegram", title: telegram.title })}>
          📱 {telegram.title || "텔레그램"}
        </button>
      {/if}
      {#each webConvs as w (w.id)}
        <div class="conv-row">
          <button class="conv" class:active={isCurrent("web", w.id)}
                  onclick={() => selectConv({ kind: "web", id: w.id, title: w.title })}>
            💬 {w.title || w.id}
            {#if w.workDir}<span class="wd">📁 {w.workDir}</span>{/if}
          </button>
          <button class="folder" title="작업 폴더 선택 (네이티브)" onclick={() => pickFolder(w.id)}>📂</button>
        </div>
      {/each}
    </aside>
    <main class="chat">
      <div class="log">
        {#each messages as m}
          <div class="msg {m.role}">
            {#if m.text}<div>{m.text}</div>{/if}
            {#if m.image}<img alt="" src={"data:image/png;base64," + m.image} />{/if}
          </div>
        {/each}
        {#if working}<div class="working">작업 진행 중…</div>{/if}
      </div>
      <div class="composer">
        <textarea bind:value={input} onkeydown={onKey} rows="1" placeholder="메시지 또는 !명령…"></textarea>
        <button onclick={send}>전송</button>
      </div>
    </main>
  </div>
</div>

<style>
  :global(body) { margin: 0; font-family: system-ui, sans-serif; font-size: 13px; color: #0f172a; }
  .app { display: flex; flex-direction: column; height: 100vh; background: #eef2ff; }
  .hdr { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #1e293b; color: #fff; font-weight: 600; }
  .status { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #dc2626; }
  .status.on { background: #16a34a; }
  .body { flex: 1; min-height: 0; display: grid; grid-template-columns: 260px 1fr; }
  .side { border-right: 1px solid #cbd5e1; background: rgba(241,245,249,.85); overflow-y: auto; display: flex; flex-direction: column; }
  .side-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; font-weight: 700; color: #334155; border-bottom: 1px solid #cbd5e1; }
  .side-head button { border: 1px solid #cbd5e1; background: #fff; border-radius: 8px; width: 28px; height: 28px; cursor: pointer; }
  .conv-row { display: flex; align-items: center; gap: 4px; padding: 2px 6px; }
  .conv { flex: 1; text-align: left; border: 1px solid transparent; background: transparent; border-radius: 6px; padding: 8px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
  .conv:hover { background: #e2e8f0; }
  .conv.active { background: #dbeafe; border-color: #93c5fd; }
  .wd { font-size: 11px; color: #475569; }
  .folder { border: 1px solid #cbd5e1; background: #fff; border-radius: 6px; cursor: pointer; padding: 4px 6px; }
  .chat { min-width: 0; display: flex; flex-direction: column; }
  .log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 80%; padding: 8px 10px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: #2563eb; color: #fff; }
  .msg.assistant { align-self: flex-start; background: #fff; }
  .msg.system { align-self: center; background: #fef3c7; color: #92400e; font-size: 12px; }
  .msg img { max-width: 100%; border-radius: 6px; display: block; margin-top: 4px; }
  .working { align-self: flex-start; color: #64748b; font-size: 12px; }
  .composer { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #cbd5e1; background: rgba(255,255,255,.85); }
  .composer textarea { flex: 1; resize: none; border: 1px solid #cbd5e1; border-radius: 6px; padding: 7px 8px; font: inherit; min-height: 34px; }
  .composer button { border: 0; background: #2563eb; color: #fff; border-radius: 6px; padding: 0 16px; cursor: pointer; }
</style>

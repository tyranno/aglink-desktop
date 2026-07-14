import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const app = readFileSync(join(root, "src", "App.svelte"), "utf8");
const pane = readFileSync(join(root, "src", "PaneNode.svelte"), "utf8");
const store = readFileSync(join(root, "src", "paneStore.svelte.js"), "utf8");
const css = readFileSync(join(root, "src", "app.css"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const all = `${app}\n${pane}\n${store}`;

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exitCode = 1;
  }
}

const header = app.match(/<header[\s\S]*?<\/header>/)?.[0] || "";
const chatLog = pane.match(/<div use:registerPaneLog[\s\S]*?{#if paneWorking\(p\.target\)/)?.[0] || "";
const composer = pane.match(/<div class="shrink-0 border-t[\s\S]*?<\/main>/)?.[0] || "";

assert(!all.includes("Wails 3 + Svelte 5"), "desktop shell must not expose framework text");
assert(!app.includes("w-screen") && !app.includes("h-screen"), "root shell must not use viewport classes that create Wails scrollbars");
assert(/body[\s\S]*overflow:\s*hidden/.test(css), "body must hide document-level overflow");
assert(!header.match(/>\s*설정\s*</), "header settings action must be an icon button");
assert(!header.match(/>\s*연결 \/ aglink\s*</), "header connection action must be an icon button");
assert(!all.match(/>\s*관리\s*</), "conversation menu trigger must be an icon button");
assert(!all.match(/>\s*파일 첨부\s*</), "attachment trigger must be an icon button");
assert(store.includes("sentHistory"), "composer must keep sent message history");
assert(store.includes('event.key === "ArrowUp"'), "composer must recall sent history on ArrowUp");
assert(store.includes("function handleComposerPaste"), "composer must handle pasted clipboard images");
assert(pane.includes("onpaste={(event) => handleComposerPaste(p.id, event)}"), "composer textarea must wire the clipboard paste handler");
assert(store.includes("ControlService.SaveClipboardImage"), "clipboard image paste must persist the image through the desktop service");
assert(store.includes("ControlService.StageAttachment"), "picked files must be staged into teleclaude attachments before upload");
assert(store.includes("attachments: []"), "each pane must keep its own multiple attachments");
assert(!all.includes("let attachedFilePath"), "composer must not keep only one global attachment path");
assert(store.includes("function imageFilesFromClipboard"), "clipboard paste must collect every pasted image item");
assert(store.includes("function appendPaneAttachment"), "attachment state must append rather than replace");
assert(store.includes("function clearPaneAttachment(paneId, index)"), "each attachment must be individually removable");
assert(store.includes("for (const attachment of pendingAttachments)"), "send must upload queued attachments sequentially");
assert(pane.includes("attachment.previewURL"), "attachment UI must keep an image thumbnail preview URL per item");
assert(store.includes("URL.createObjectURL"), "pasted image attachments must use object URLs for thumbnail preview");
assert(store.includes("URL.revokeObjectURL"), "attachment thumbnail object URLs must be revoked when replaced or cleared");
assert(store.includes("ControlService.PreviewAttachmentImage"), "picked local images must get a desktop preview data URL");
assert(all.includes("SetChannelBackend"), "channel backend setting must be wired to ControlService");
assert(store.includes('UploadAttachment(attachment.path, caption, p.target.kind, p.target.id || "")'), "attachment uploads must preserve the selected conversation target");
assert(!all.includes("기본 텔레그램 스트림"), "sidebar conversation rows must stay single-line");
assert(!all.includes("rounded-[28px]") && !all.includes("rounded-3xl"), "desktop cards must use compact radii");
assert(chatLog.includes("flex-1") && chatLog.includes("overflow-y-auto"), "chat log must be a flexible scrolling region");
assert(!chatLog.includes("max-w-5xl"), "chat message area must expand with the desktop window");
assert(!chatLog.includes("78ch"), "message bubbles must not keep the old narrow fixed reading width");
assert(chatLog.includes("px-3 py-1.5"), "message bubbles must use tighter vertical padding");
assert(chatLog.includes("text-[13px] leading-4"), "message text must use compact desktop font sizing");
assert(chatLog.includes("mt-2"), "message image spacing must stay compact");
assert(!composer.includes("max-w-5xl"), "composer and attachment rows must expand with the chat area");
assert(composer.includes("attachments") && composer.includes("attachment.previewURL") && composer.includes("<img"), "attachment thumbnails must render inline in the composer");
assert(!composer.includes("mb-3 flex w-full items-center gap-2 rounded-lg border border-emerald-200"), "attachment UI must not be a separate full-width banner");
assert(!html.includes("/style.css"), "Wails starter CSS must not be loaded");
assert(!html.includes("Wails + Svelte"), "window title must not expose framework text");
assert(!html.includes("wails.png"), "favicon must not use the Wails starter icon");
assert(html.includes("<title>teleclaude</title>"), "HTML title must be teleclaude");
assert(!all.includes(">aglink-chat<"), "desktop visible app title must be teleclaude, not aglink-chat");
assert(store.includes("const SLASH_COMMANDS"), "composer must define the known !command list for autocomplete");
assert(store.includes("function showCommandMenuForPane"), "composer must derive whether the command menu is visible per pane");
assert(composer.includes("bottom-full") && composer.includes("role=\"listbox\""), "command menu must render as a dropdown above the composer input");
assert(store.includes("function selectCommandForPane"), "command menu must support selecting a command");
assert(store.includes('event.key === "Escape"') && store.includes("commandMenuHidden: true"), "command menu must be dismissible with Escape");
assert(store.includes("panes: [") && store.includes("export const chat = $state("), "pane state must live in the shared reactive store");
assert(store.includes("export function addPane") && store.includes("export function closePane"), "app must support adding and closing split panes");
assert(store.includes("export const MAX_PANES"), "split panes must be capped to a sane maximum");
assert(app.includes("let sidebarCollapsed = $state(false)"), "conversation list sidebar must be collapsible");
assert(!header.includes("sidebarCollapsed"), "sidebar visibility toggle must live in the sidebar itself, not the top header");
assert(app.match(/onclick={\(\) => \(sidebarCollapsed = true\)}/), "sidebar toolbar must expose its own collapse control");
assert(app.match(/onclick={\(\) => \(sidebarCollapsed = false\)}/), "a collapsed-sidebar handle must remain in the conversation list area to re-expand it");
assert(!all.includes("let currentTarget"), "chat state must be per-pane, not a single global target");
assert(!all.includes("let splitDirection"), "layout direction must be per-split (docking tree), not one global toggle");

// Docking window structure: recursive split tree instead of a flat pane row.
assert(app.includes('import PaneNode from "./PaneNode.svelte"'), "App shell must delegate pane layout to the recursive PaneNode component");
assert(pane.includes('import PaneNode from "./PaneNode.svelte"'), "PaneNode must recurse into itself to render nested splits");
assert(store.includes("type: \"leaf\"") && store.includes("type: \"split\""), "layout must be a tree of leaf/split nodes, not a flat array");
assert(store.includes("function insertAtEdge"), "docking must support inserting a pane at an edge of another pane");
assert(store.includes("function removeLeaf"), "docking must support removing a pane from the tree and collapsing empty splits");
assert(store.includes("function swapLeaves"), "dropping on the center of a pane must swap the two panes");
assert(store.includes("export function startSplitResize"), "each split node must support independent drag-to-resize of its own children");
assert(store.includes("export const MIN_PANE_PERCENT"), "pane resize must enforce a minimum size so a pane cannot be dragged to zero");
assert(pane.includes('draggable="true"') && pane.includes("ondragstart={(event) => handlePaneDragStart(event, p.id)}"), "a pane's header must be draggable to redock it");
assert(pane.includes("ondragover={(event) => handlePaneDragOver(event, p.id)}") && pane.includes("ondrop={(event) => handlePaneDrop(event, p.id)}"), "a pane must accept drops to dock another pane against one of its edges");
assert(store.includes('if (x < 0.25) return "left"'), "drop targeting must resolve which edge (or center) the cursor is over");
assert(pane.includes("chat.overPaneId === p.id"), "dragging over a pane must show a drop-zone indicator overlay");

// Dragging a conversation straight out of the sidebar list to dock it into a pane.
assert(store.includes("export function handleConversationDragStart"), "sidebar conversations must be draggable, not just existing panes");
assert(store.includes("export function dockConversation"), "dropping a dragged conversation must open it in a new or existing pane depending on the drop zone");
assert(app.includes("ondragstart={(event) => handleConversationDragStart(event, { kind: \"telegram\" })}"), "the telegram sidebar row must be draggable");
assert(app.includes("ondragstart={(event) => handleConversationDragStart(event, { kind: \"web\", id: conv.id })}"), "each web conversation sidebar row must be draggable");
assert(store.includes("chat.draggingConversation") && store.includes("if (draggedConversation)"), "pane drop handling must branch between redocking an existing pane and opening a dragged conversation");

if (process.exitCode) {
  process.exit(process.exitCode);
}

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const app = readFileSync(join(root, "src", "App.svelte"), "utf8");
const css = readFileSync(join(root, "src", "app.css"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exitCode = 1;
  }
}

const header = app.match(/<header[\s\S]*?<\/header>/)?.[0] || "";
const chatLog = app.match(/<div bind:this={logEl}[\s\S]*?{#if currentWorking/)?.[0] || "";
const composer = app.match(/<div class="shrink-0 border-t[\s\S]*?<\/main>/)?.[0] || "";

assert(!app.includes("Wails 3 + Svelte 5"), "desktop shell must not expose framework text");
assert(!app.includes("w-screen") && !app.includes("h-screen"), "root shell must not use viewport classes that create Wails scrollbars");
assert(/body[\s\S]*overflow:\s*hidden/.test(css), "body must hide document-level overflow");
assert(!header.match(/>\s*설정\s*</), "header settings action must be an icon button");
assert(!header.match(/>\s*연결 \/ aglink\s*</), "header connection action must be an icon button");
assert(!app.match(/>\s*관리\s*</), "conversation menu trigger must be an icon button");
assert(!app.match(/>\s*파일 첨부\s*</), "attachment trigger must be an icon button");
assert(app.includes("sentHistory"), "composer must keep sent message history");
assert(app.includes('event.key === "ArrowUp"'), "composer must recall sent history on ArrowUp");
assert(app.includes("function handleComposerPaste"), "composer must handle pasted clipboard images");
assert(app.includes("onpaste={handleComposerPaste}"), "composer textarea must wire the clipboard paste handler");
assert(app.includes("ControlService.SaveClipboardImage"), "clipboard image paste must persist the image through the desktop service");
assert(app.includes("ControlService.StageAttachment"), "picked files must be staged into teleclaude attachments before upload");
assert(app.includes("let attachments = $state([])"), "composer must keep multiple attachments");
assert(!app.includes("let attachedFilePath"), "composer must not keep only one attachment path");
assert(app.includes("function imageFilesFromClipboard"), "clipboard paste must collect every pasted image item");
assert(app.includes("function appendAttachment"), "attachment state must append rather than replace");
assert(app.includes("function clearAttachment(index)"), "each attachment must be individually removable");
assert(app.includes("for (const attachment of pendingAttachments)"), "send must upload queued attachments sequentially");
assert(app.includes("attachment.previewURL"), "attachment UI must keep an image thumbnail preview URL per item");
assert(app.includes("URL.createObjectURL"), "pasted image attachments must use object URLs for thumbnail preview");
assert(app.includes("URL.revokeObjectURL"), "attachment thumbnail object URLs must be revoked when replaced or cleared");
assert(app.includes("ControlService.PreviewAttachmentImage"), "picked local images must get a desktop preview data URL");
assert(app.includes("SetChannelBackend"), "channel backend setting must be wired to ControlService");
assert(app.includes('UploadAttachment(attachment.path, caption, currentTarget.kind, currentTarget.id || "")'), "attachment uploads must preserve the selected conversation target");
assert(!app.includes("기본 텔레그램 스트림"), "sidebar conversation rows must stay single-line");
assert(!app.includes("rounded-[28px]") && !app.includes("rounded-3xl"), "desktop cards must use compact radii");
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
assert(!app.includes(">aglink-chat<"), "desktop visible app title must be teleclaude, not aglink-chat");

if (process.exitCode) {
  process.exit(process.exitCode);
}

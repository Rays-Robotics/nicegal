// Capture guide controls, or the user-approved test gallery for the README with --showcase.
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone Node capture script. */
// Run against the dev app with no open dialogs or image-reference query. Restores the text query.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const target = targets.find((entry) => entry.type === "page");
assert.ok(target, "Start the dev app with CDP on port 9222 first.");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
let nextId = 0;
const pending = new Map();
socket.addEventListener("message", ({ data }) => {
  const response = JSON.parse(data);
  if (!response.id) return;
  const request = pending.get(response.id);
  pending.delete(response.id);
  if (response.error) request.reject(new Error(JSON.stringify(response.error)));
  else request.resolve(response.result);
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
const setQuery = (value) =>
  evaluate(`(() => {
  const input = document.querySelector('input[aria-label="Search"]');
  input.value = ${JSON.stringify(value)};
  input.dispatchEvent(new Event('input', {bubbles: true}));
})()`);
const showcase = process.argv.includes("--showcase");
const output = new URL(
  showcase ? "../docs/images/" : "../src/renderer/src/assets/guide/",
  import.meta.url,
);
let started = false;
let previousHudVisibility = "";
let previousQuery = "";
let previousScroll = 0;
let previousSort = "Relevance";
const setSort = (label) =>
  evaluate(
    `Array.from(document.querySelectorAll('.search-options [role="radio"]')).find(button => button.textContent.trim() === ${JSON.stringify(label)})?.click()`,
  );
try {
  assert.ok(
    await evaluate(
      `Boolean(document.querySelector('input[aria-label="Search"]')) && !document.querySelector('input[aria-label="Search"]').value.trim().toLowerCase().startsWith('like:') && !document.querySelector('dialog[open], .photo-reference-chip, .scope-menu, .visual-composer')`,
    ),
    "Return to the gallery, close dialogs/popovers and clear image-reference searches before capturing.",
  );
  previousQuery = await evaluate(`document.querySelector('input[aria-label="Search"]').value`);
  previousScroll = await evaluate(`document.querySelector('.gallery-viewport').scrollTop`);
  previousSort = await evaluate(
    `Array.from(document.querySelectorAll('.search-options [role="radio"]')).find(button => button.getAttribute('aria-checked') === 'true')?.textContent.trim() ?? 'Relevance'`,
  );
  started = true;
  await setQuery("");
  await settle();
  await mkdir(output, { recursive: true });
  async function capture(selector, name) {
    // Capture past fractional edges; Pillow trims to the existing solid border after capture.
    const clip = await evaluate(
      selector
        ? `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); const x=Math.floor(r.x), y=Math.floor(r.y); return {x,y,width:Math.ceil(r.right)-x,height:Math.ceil(r.bottom)-y+1,scale:2/devicePixelRatio}; })()`
        : `({x:0,y:0,width:innerWidth,height:innerHeight,scale:2/devicePixelRatio})`,
    );
    const result = await call("Page.captureScreenshot", { format: "png", clip });
    await writeFile(new URL(name, output), Buffer.from(result.data, "base64"));
    console.log(`${name}: ${clip.width} × ${clip.height} CSS pixels, captured at 2×`);
  }
  async function waitForGallery() {
    for (let attempt = 0; attempt < 150; attempt++) {
      const ready = await evaluate(`(() => {
        if (document.querySelector('.search-error')) throw Error(document.querySelector('.search-error').textContent);
        const gallery=document.querySelector('.gallery-viewport');
        if (!gallery || document.querySelector('.index-activity-indicator.active')) return false;
        const bounds=gallery.getBoundingClientRect();
        const visible=Array.from(gallery.querySelectorAll('.gallery-frame img')).filter(img=>{const r=img.getBoundingClientRect();return r.bottom>bounds.top && r.top<bounds.bottom;});
        return visible.length>0 && visible.every(img=>img.complete && img.naturalWidth>0);
      })()`);
      if (ready) return;
      await settle();
    }
    const diagnostic = await evaluate(
      `(() => { const gallery=document.querySelector('.gallery-viewport'); const bounds=gallery.getBoundingClientRect(); return {top:gallery.scrollTop, height:gallery.scrollHeight, pending:!!document.querySelector('.index-activity-indicator.active'), visible:Array.from(gallery.querySelectorAll('.gallery-frame img')).filter(img=>{const r=img.getBoundingClientRect();return r.bottom>bounds.top&&r.top<bounds.bottom;}).map(img=>({name:img.alt,complete:img.complete,width:img.naturalWidth}))}; })()`,
    );
    throw new Error(
      `Gallery did not finish loading; no showcase screenshot was captured: ${JSON.stringify(diagnostic)}`,
    );
  }
  async function scrollToMiddle() {
    await evaluate(
      `(() => {const gallery=document.querySelector('.gallery-viewport');gallery.scrollTop=(gallery.scrollHeight-gallery.clientHeight)/2;})()`,
    );
    await settle();
    await waitForGallery();
  }
  if (showcase) {
    previousHudVisibility = await evaluate(
      `(() => {const hud=document.querySelector('.perf-hud');const previous=hud?.style.visibility ?? '';if(hud)hud.style.visibility='hidden';return previous;})()`,
    );
    await setQuery("like: 2:cats + funny");
    await settle();
    await setSort("Relevance");
    await settle();
    await settle();
    await waitForGallery();
    await scrollToMiddle();
    await evaluate(
      `document.querySelector('.compose-chip').click(); document.querySelector('input[aria-label="Search"]').focus()`,
    );
    await settle();
    await capture(null, "gallery-composer.png");
    await setQuery("");
    await settle();
    await scrollToMiddle();
    await evaluate(`document.querySelector('.scope-button').click()`);
    await settle();
    await capture(null, "gallery-search-menu.png");
    await evaluate(`document.querySelector('.scope-button').click()`);
    await setQuery("cats");
    await settle();
    await waitForGallery();
    await evaluate(`document.querySelector('.gallery-viewport').scrollTop=0`);
    await settle();
    await capture(null, "gallery-all-search.png");
  } else {
    await evaluate(`document.querySelector('.scope-button').click()`);
    await settle();
    await capture(".scope-menu", "search-menu.png");
    await evaluate(`document.querySelector('.scope-button').click()`);
    await setQuery("like: 2:sunset - crowds");
    await settle();
    await evaluate(
      `document.querySelector('.compose-chip').click(); document.querySelector('input[aria-label="Search"]').focus()`,
    );
    await settle();
    await capture(".visual-composer .term-list", "visual-search.png");
    const trim = spawnSync(
      "uvx",
      [
        "--with",
        "pillow",
        "python",
        fileURLToPath(new URL("./guide-image-borders.py", import.meta.url)),
        "--trim",
      ],
      { stdio: "inherit" },
    );
    if (trim.error) throw trim.error;
    assert.equal(trim.status, 0, "Screenshot border verification failed.");
  }
} finally {
  if (started) {
    await setQuery(previousQuery);
    await settle();
    await setSort(previousSort);
    // Restoration waits for progressive lanes too, without requiring a nonempty result set.
    for (let attempt = 0; attempt < 150; attempt++) {
      if (
        attempt > 2 &&
        (await evaluate(`!document.querySelector('.index-activity-indicator.active')`))
      )
        break;
      await settle();
    }
    await evaluate(`document.querySelector('.gallery-viewport').scrollTop=${previousScroll}`);
  }
  if (started && showcase) {
    await settle();
    await evaluate(
      `(() => {const hud=document.querySelector('.perf-hud');if(hud)hud.style.visibility=${JSON.stringify(previousHudVisibility)};})()`,
    );
  }
  socket.close();
}

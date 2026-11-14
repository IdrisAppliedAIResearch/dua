import { spawn } from "node:child_process";
import { startChrome, CDP, sleep } from "./lib.mjs";

const PORT = 8645;
const CDP_PORT = 9337;
const DB = process.env.TEMP + "/dua-dbg2.db";

const server = spawn(
  "python",
  ["-c", "import uvicorn;from dua.app import create_app;uvicorn.run(create_app(),port=8645,log_level='warning')"],
  { env: { ...process.env, DUA_DB: DB }, stdio: "ignore" }
);

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/entries`)).ok; } catch (_) {}
    if (!up) await sleep(200);
  }
  const chrome = await startChrome(CDP_PORT);
  const cdp = await CDP.connect(CDP_PORT);
  await cdp.goto(`http://127.0.0.1:${PORT}/`);

  console.log("state0:", await cdp.eval("JSON.stringify({spread: window.__dua.state.spread, editing: window.__dua.state.editing})"));
  console.log("index-new:", await cdp.eval("(() => { const r = document.getElementById('index-tab').getBoundingClientRect(); return JSON.stringify({x: r.x, y: r.y, w: r.width, h: r.height}); })()"));
  await cdp.key("i");
  await cdp.waitFor("!document.getElementById('index-overlay').hidden");
  await cdp.clickSel("#index-new");
  await sleep(400);
  console.log("after400:", await cdp.eval("JSON.stringify({spread: window.__dua.state.spread, editing: window.__dua.state.editing, busy: window.__dua.book.busy})"));
  await sleep(2500);
  console.log("after2900:", await cdp.eval("JSON.stringify({spread: window.__dua.state.spread, editing: window.__dua.state.editing, ce: document.querySelectorAll('[contenteditable]').length})"));
  cdp.close();
  chrome.kill();
} finally {
  server.kill();
}

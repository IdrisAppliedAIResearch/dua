import { spawn } from "node:child_process";
import { startChrome, CDP, sleep } from "./lib.mjs";

const PORT = 8644;
const CDP_PORT = 9336;
const DB = process.env.TEMP + "/dua-debug.db";

const server = spawn(
  "python",
  ["-c", "import uvicorn;from dua.app import create_app;uvicorn.run(create_app(),port=8644,log_level='warning')"],
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
  await cdp.cmd("Page.enable");
  await cdp.cmd("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1200);
  for (const mod of ["./js/state.js", "./js/api.js", "./js/layout.js", "./js/book.js", "./js/editor.js", "./js/main.js"]) {
    const err = await cdp.eval(`import(${JSON.stringify(mod)}).then(()=>'ok').catch(e=>e.message + ' @ ' + (e.stack||'').split('\\n')[1])`);
    console.log(mod, "=>", err);
  }
  cdp.close();
  chrome.kill();
} finally {
  server.kill();
}

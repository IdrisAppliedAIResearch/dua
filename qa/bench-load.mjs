import { startChrome, CDP, sleep } from "./lib.mjs";

const url = process.argv[2] || "http://127.0.0.1:8644";
const size = process.argv[3] || "1440,900";
const port = Number(process.argv[4] || 9360);

const chrome = await startChrome(port, size);
try {
  const cdp = await CDP.connect(port);
  await cdp.cmd("Page.enable");
  await cdp.cmd("Runtime.enable");
  const t0 = Date.now();
  await cdp.cmd("Page.navigate", { url });
  let readyAt = -1;
  for (let i = 0; i < 900; i++) {
    let ready = false;
    try {
      ready = await cdp.eval("window.__duaReady === true");
    } catch (_) {}
    if (ready) {
      readyAt = Date.now() - t0;
      break;
    }
    await sleep(100);
  }
  console.log(`viewport ${size} ready in ${readyAt < 0 ? ">90s TIMEOUT" : readyAt + "ms"}`);
  if (readyAt >= 0) {
    const info = await cdp.eval(`({
      pages: document.querySelectorAll('.face.page').length,
      leaves: document.querySelectorAll('.leaf').length,
      entries: window.__dua.state.entries.length,
      renderMs: window.__duaRenderMs ?? null,
    })`);
    console.log(JSON.stringify(info));
  }
  if (cdp.exceptions.length) console.log("EXCEPTIONS:", JSON.stringify(cdp.exceptions));
  cdp.close();
} finally {
  chrome.kill();
}

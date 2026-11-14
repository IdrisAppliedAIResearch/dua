import { startChrome, CDP, sleep } from "./lib.mjs";

const url = process.argv[2] || "http://127.0.0.1:8644";
const port = Number(process.argv[3] || 9382);

const chrome = await startChrome(port, "420,880");
try {
  const cdp = await CDP.connect(port);
  await cdp.goto(url);
  await cdp.clickSel(".cover");
  await sleep(1000);
  await cdp.eval("window.__dua.book.gotoInstant(3)");
  await sleep(300);
  const pen = await cdp.center(".face.cur-right .pencil");
  await cdp.click(pen.x, pen.y);
  await sleep(900);
  await cdp.shot("qa/shots/20-mobile-toprail.png");
  await cdp.eval("window.__dua.editor.cancel()");
  await sleep(400);
  await cdp.key("i");
  await sleep(400);
  await cdp.shot("qa/shots/21-index-mobile.png");
  await cdp.eval("document.getElementById('index-scroll').scrollTop = 99999");
  await sleep(250);
  await cdp.shot("qa/shots/22-index-mobile-bottom.png");
  await cdp.close();
} finally {
  chrome.kill();
}

const chrome2 = await startChrome(port + 1, "1440,900");
try {
  const cdp = await CDP.connect(port + 1);
  await cdp.cmd("Emulation.setEmulatedMedia", {
    features: [{ name: "hover", value: "hover" }],
  });
  await cdp.goto(url);
  await cdp.clickSel(".cover");
  await sleep(1000);
  await cdp.key("i");
  await sleep(400);
  await cdp.shot("qa/shots/23-index-desktop.png");
  cdp.close();
} finally {
  chrome2.kill();
}

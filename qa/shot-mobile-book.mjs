import { startChrome, CDP, sleep } from "./lib.mjs";

const url = process.argv[2] || "http://127.0.0.1:8644";
const port = Number(process.argv[3] || 9371);

const chrome = await startChrome(port, "420,880");
try {
  const cdp = await CDP.connect(port);
  await cdp.goto(url);
  await cdp.clickSel(".cover");
  await sleep(1000);
  await cdp.shot("qa/shots/17-mobile-spread1.png");
  await cdp.eval("window.__dua.book.gotoInstant(3)");
  await sleep(300);
  await cdp.shot("qa/shots/18-mobile-spread3.png");
  await cdp.close();
} finally {
  chrome.kill();
}

const chrome2 = await startChrome(port + 1, "1440,900");
try {
  const cdp = await CDP.connect(port + 1);
  await cdp.goto(url);
  await cdp.clickSel(".cover");
  await sleep(1000);
  await cdp.eval("window.__dua.book.gotoInstant(4)");
  await cdp.eval("const s=document.createElement('style');s.textContent='.face.cur-right .pencil,.face.cur-left .pencil{opacity:.55 !important}';document.head.append(s)");
  await sleep(200);
  await cdp.shot("qa/shots/19-desktop-pencil.png");
  cdp.close();
} finally {
  chrome2.kill();
}

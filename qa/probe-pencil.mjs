import { startChrome, CDP, sleep } from "./lib.mjs";

const url = process.argv[2] || "http://127.0.0.1:8644";
const size = process.argv[3] || "420,880";
const port = Number(process.argv[4] || 9367);

const chrome = await startChrome(port, size);
try {
  const cdp = await CDP.connect(port);
  await cdp.goto(url);
  await cdp.clickSel(".cover");
  await sleep(1000);
  await cdp.eval("window.__dua.book.gotoInstant(3)");
  await sleep(400);
  const info = await cdp.eval(`(() => {
    const f = document.querySelector('.face.cur-right');
    const pen = f && f.querySelector('.pencil');
    if (!pen) return { err: 'no pencil', face: f && f.className };
    const r = pen.getBoundingClientRect();
    const cs = getComputedStyle(pen);
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const hit2 = f.querySelector('.page-body') && document.elementFromPoint(
      Math.min(r.x + r.width / 2, f.getBoundingClientRect().right - 5),
      Math.max(r.y + r.height / 2, f.getBoundingClientRect().top + 5));
    return {
      face: f.className,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      faceRect: (() => { const b = f.getBoundingClientRect(); return { x: b.x, y: b.y, r: b.right, b: b.bottom }; })(),
      opacity: cs.opacity, display: cs.display, pe: cs.pointerEvents,
      hit: hit && (hit.tagName + "." + (hit.className.baseVal ?? hit.className)),
      hit2: hit2 && (hit2.tagName + "." + (hit2.className.baseVal ?? hit2.className)),
    };
  })()`);
  console.log(JSON.stringify(info, null, 1));
  await cdp.dblClickSel(".face.cur-right .pencil");
  await sleep(900);
  console.log("editing after dblClickSel:", await cdp.eval("window.__dua.state.editing !== null"));
  console.log("spread:", await cdp.eval("window.__dua.state.spread"));
  cdp.close();
} finally {
  chrome.kill();
}

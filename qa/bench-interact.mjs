import { startChrome, CDP, sleep, assert } from "./lib.mjs";

const url = process.argv[2] || "http://127.0.0.1:8644";
const port = Number(process.argv[3] || 9363);

const chrome = await startChrome(port, "420,880");
try {
  const cdp = await CDP.connect(port);
  await cdp.cmd("Page.enable");
  await cdp.cmd("Runtime.enable");

  await cdp.cmd("Page.navigate", { url });
  const t0 = Date.now();
  assert(await cdp.waitFor("window.__duaReady === true", 30000), `ready in ${Date.now() - t0}ms`);

  const faceX = (sel, frac) => cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width * ${frac}), y: Math.round(r.y + r.height / 2) };
  })()`);

  // open the book
  await cdp.clickSel(".cover");
  await sleep(1000);
  assert(await cdp.eval("window.__dua.state.spread === 1"), "opened");

  // spam right-half taps during animation (20 taps, no idle waits)
  for (let i = 0; i < 20; i++) {
    const p = await faceX(".face.cur-right", 0.75);
    if (p) await cdp.click(p.x, p.y);
    await sleep(120);
  }
  await cdp.waitIdle();
  const s1 = await cdp.eval("window.__dua.state.spread");
  const max1 = await cdp.eval("window.__dua.book.max");
  assert(s1 >= 2 && s1 <= max1, `spam turns: spread=${s1} max=${max1} (no stuck/overflow)`);
  assert(await cdp.eval("!window.__dua.book.busy"), "busy flag released");

  // alternate left-edge back and right forward, rapidly
  for (let i = 0; i < 10; i++) {
    const l = await faceX(".face.cur-left", 0.2);
    if (l) await cdp.click(l.x, l.y);
    await sleep(90);
    const r = await faceX(".face.cur-right", 0.8);
    if (r) await cdp.click(r.x, r.y);
    await sleep(90);
  }
  await cdp.waitIdle();
  const s2 = await cdp.eval("window.__dua.state.spread");
  assert(s2 >= 0 && s2 <= max1, `alternate turns sane: spread=${s2}`);

  // double-tap style (iOS sends two clicks + dblclick): proper 1-1-2-2 sequence
  await cdp.eval("window.__dua.book.gotoInstant(3)");
  await sleep(300);
  const mid = await faceX(".face.cur-right", 0.5);
  if (mid) {
    for (const cc of [1, 2]) {
      await cdp.cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: mid.x, y: mid.y, button: "left", clickCount: cc });
      await cdp.cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: mid.x, y: mid.y, button: "left", clickCount: cc });
    }
    await sleep(1200);
  }
  const editing = await cdp.eval("window.__dua.state.editing !== null");
  const s3 = await cdp.eval("window.__dua.state.spread");
  const editableVisible = await cdp.eval(`(() => {
    if (!window.__dua.state.editing) return null;
    const p = document.querySelector('.entry.editing p');
    if (!p) return 'no-editable';
    const f = p.closest('.face');
    const vis = f.classList.contains('cur-left') || f.classList.contains('cur-right') ||
      [...f.classList].includes('recto') && f.parentElement.classList.contains('flipped') ===
      f.classList.contains('back');
    return 'ok';
  })()`);
  console.log(`info double-click: editing=${editing} spread=${s3} editable=${editableVisible}`);
  if (editing) {
    await cdp.eval("window.__dua.editor.cancel()");
    await sleep(300);
  }

  // pencil tap -> edit -> save roundtrip on a seeded entry
  await cdp.eval("window.__dua.book.gotoInstant(3)");
  await sleep(300);
  const pen = await cdp.eval(`(() => {
    const el = document.querySelector('.face.cur-right .pencil');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (pen) {
    await cdp.click(pen.x, pen.y);
    await sleep(800);
    const opened = await cdp.eval("window.__dua.state.editing !== null");
    if (!opened) {
      console.log("pencil diag:", JSON.stringify(await cdp.eval(`(() => {
        const el = document.elementFromPoint(${pen.x}, ${pen.y});
        return { hit: el && (el.className.baseVal ?? el.className), tag: el?.tagName,
          spread: window.__dua.state.spread, busy: window.__dua.book.busy,
          editing: window.__dua.state.editing };
      })()`)));
    }
    assert(opened, "pencil opened edit");
    // do NOT save against live seeded data (collect() reflows whitespace);
    // cancel exercises the same teardown path safely
    await cdp.eval("window.__dua.editor.cancel()");
    await sleep(900);
    assert(await cdp.eval("window.__dua.state.editing === null"), "cancel closed edit");
  }

  // resize storm (iOS address-bar collapses fire many resizes fast)
  for (let i = 0; i < 6; i++) {
    const h = i % 2 ? 620 : 880;
    await cdp.cmd("Emulation.setDeviceMetricsOverride", { width: 420, height: h, deviceScaleFactor: 2, mobile: true });
    await sleep(80);
  }
  await sleep(700);
  const okResize = await cdp.eval(`(() => {
    const b = window.__dua.book;
    const visible = [...b.leaves].filter((l) => !l.el.classList.contains("dormant")).length;
    return window.__dua.state.spread <= b.max && b.leaves.length === b.L &&
      visible <= 3 && !document.querySelector('.entry [contenteditable]');
  })()`);
  assert(okResize, "state sane after resize storm (and leaves virtualized)");

  // End / Home jumps
  await cdp.key("End");
  await sleep(300);
  const atEnd = await cdp.eval("window.__dua.state.spread === window.__dua.book.max");
  assert(atEnd, "End goes to max");
  await cdp.key("Home");
  await sleep(300);
  assert(await cdp.eval("window.__dua.state.spread === 0"), "Home closes");

  // memory / node count
  await cdp.cmd("Performance.enable");
  const res = await cdp.cmd("Performance.getMetrics");
  const m = Object.fromEntries(res.metrics.map((x) => [x.name, x.value]));
  console.log(`heap=${Math.round(m.JSHeapUsedSize / 1e6)}MB nodes=${m.Nodes}`);

  const entriesNow = await cdp.eval("window.__dua.state.entries.length");
  assert(entriesNow === 62, `entries intact: ${entriesNow}`);
  console.log(cdp.exceptions.length ? "EXCEPTIONS: " + JSON.stringify(cdp.exceptions) : "no exceptions");
  await cdp.shot("qa/shots/16-bench-mobile.png");
  cdp.close();
} finally {
  chrome.kill();
}

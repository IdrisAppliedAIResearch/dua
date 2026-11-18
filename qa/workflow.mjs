import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { startChrome, CDP, sleep, assert } from "./lib.mjs";

const PORT = 8647;
const CDP_PORT = 9335 + (process.pid % 50);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const DB = process.env.TEMP + "/dua-e2e-" + Date.now() + ".db";

mkdirSync(new URL("./shots/", import.meta.url), { recursive: true });
// a real (tiny) PNG, so the API stores real bytes and the <img> decodes
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP8z8DAwMDAxMDAwMAAAA" +
    "wAAwA6eQx8AAAAAElFTkSuQmCC",
  "base64"
);

const server = spawn(
  "python",
  ["-c", "import uvicorn;from dua.app import create_app;uvicorn.run(create_app(),port=8647,log_level='warning')"],
  { env: { ...process.env, DUA_DB: DB }, stdio: "ignore" }
);

let chrome = null;
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      up = (await fetch(APP_URL + "api/entries")).ok;
    } catch (_) {}
    if (!up) await sleep(200);
  }
  if (!up) throw new Error("server never came up");

  // A picture is bytes in the database now, so the harness adds its three the
  // way anything else does: one POST each, no folder staged beside the book.
  for (const name of ["p1.png", "p2.png", "p3.png"]) {
    const put = await fetch(APP_URL + "api/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, data_b64: PNG.toString("base64") }),
    });
    if (!put.ok) throw new Error(`could not add ${name}: HTTP ${put.status}`);
  }

  const chrome_ = await startChrome(CDP_PORT);
  chrome = chrome_;
  const cdp = await CDP.connect(CDP_PORT);
  // headless Chrome defaults to hover:none; make this session behave like a
  // real desktop browser so double-click-to-edit paths are exercised
  await cdp.cmd("Emulation.setEmulatedMedia", {
    features: [{ name: "hover", value: "hover" }, { name: "pointer", value: "fine" }],
  });
  await cdp.goto(APP_URL);

  const count = () => cdp.eval(`fetch('/api/entries').then(r=>r.json()).then(a=>a.length)`);
  const serverBody = () =>
    cdp.eval(`fetch('/api/entries').then(r=>r.json()).then(a=>a[a.length-1].body)`);

  assert((await count()) === 0, "starts with empty dua");

  await cdp.shot("qa/shots/01-cover.png");

  assert(
    (await cdp.eval("window.__dua.book.single === true")) &&
      (await cdp.eval(
        `Math.abs(document.querySelector('.book').getBoundingClientRect().width - parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-w'))) < 1.5`
      )),
    "wide viewport still renders one page at a time"
  );

  await cdp.key("i");
  await cdp.waitFor("!document.getElementById('index-overlay').hidden");
  await cdp.clickSel("#index-new");
  assert(
    await cdp.waitFor("window.__dua.state.editing !== null"),
    "index + button opens new draft"
  );
  assert(
    await cdp.waitFor("document.querySelectorAll('[contenteditable]').length >= 1"),
    "draft is editable"
  );
  await cdp.waitIdle();

  await cdp.type("First light on the lake this morning. The mist came off the water like paper burning.");
  await cdp.shot("qa/shots/02-edit-draft.png");
  await cdp.key("s", { modifiers: 2, text: "s" });
  await cdp.waitFor("fetch('/api/entries').then(r=>r.json()).then(a=>a.length===1)");
  await cdp.waitIdle();
  assert((await count()) === 1, "draft persisted on save");
  assert(
    (await serverBody()).startsWith("First light"),
    "saved body round-trips"
  );
  assert(
    await cdp.eval("window.__dua.state.editing === null"),
    "save returns to view"
  );
  await cdp.shot("qa/shots/03-one-entry.png");

  await cdp.key("i");
  await cdp.waitFor("!document.getElementById('index-overlay').hidden");
  await cdp.clickSel("#index-new");
  assert(
    await cdp.waitFor("window.__dua.state.editing !== null"),
    "index + button makes second draft"
  );
  await cdp.waitIdle();
  await cdp.type("A quiet second day, mostly rain and reading.");
  await cdp.key("s", { modifiers: 2, text: "s" });
  await cdp.waitFor("fetch('/api/entries').then(r=>r.json()).then(a=>a.length===2)");
  await cdp.waitIdle();
  assert((await count()) === 2, "second entry created");

  await cdp.key("n");
  assert(
    await cdp.waitFor("window.__dua.state.editing !== null"),
    "n-key makes third draft"
  );
  await cdp.waitIdle();
  const long =
    "A long day, the kind that needs a whole leaf and more. ".repeat(3) +
    "The garden held the heat until well past ten, and even the cats lay flat as ironing. " +
    "I mended the gate latch twice; the second time properly. Supper was lentils and bread, eaten " +
    "standing up out of sheer tiredness. " + "\n\n" +
    "Late, a thunder came up from the south and dragged its furniture across the whole sky. " +
    "The rain that followed smelled of hot dust forgiven. I sat on the step until the last grumble " +
    "went out behind the pines, and then I remembered I had never written any of this down before. " +
    "Here it is, then, in ink that is somehow still wet.";
  await cdp.type(long);
  await cdp.key("s", { modifiers: 2, text: "s" });
  await cdp.waitFor("fetch('/api/entries').then(r=>r.json()).then(a=>a.length===3)");
  await cdp.waitIdle();
  assert((await count()) === 3, "long entry created");
  const splitCount = await cdp.eval(
    `(() => { const ids = {}; document.querySelectorAll('.entry').forEach(e => ids[e.dataset.id] = (ids[e.dataset.id]||0)+1); return Math.max(...Object.values(ids)); })()`
  );
  assert(splitCount >= 2, "long entry splits across pages");

  const sBefore = await cdp.eval("window.__dua.state.spread");
  await cdp.key("ArrowRight");
  await sleep(1100);
  await cdp.waitIdle();
  assert(
    await cdp.eval(`window.__dua.state.spread === ${sBefore} + 1`),
    "arrow key turns a leaf"
  );
  // the turned leaf's blank back must not hang past the box's left edge:
  // a hit-test there must reach the desk, not paper (on the phone this
  // overhang fell off the viewport edge for free; on desktop it must be gone)
  assert(
    await cdp.eval(`(() => {
      const b = document.querySelector('.book').getBoundingClientRect();
      const pw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-w'));
      const els = document.elementsFromPoint(b.left - pw / 2, b.top + b.height / 2);
      return els.every((e) => !(e.classList && e.classList.contains('face')));
    })()`),
    "no blank pad left of the single page"
  );
  await cdp.shot("qa/shots/04-spread-continued.png");

  await cdp.key("ArrowLeft");
  await sleep(1100);
  await cdp.waitIdle();
  assert(
    await cdp.eval(`window.__dua.state.spread === ${sBefore}`),
    "turn back works"
  );

  // hard-broken lines (dua book): the author's newlines must render as forced
  // line breaks and a stanza must page-break whole, never mid-line. A future
  // date sorts the probe last so nothing earlier re-paginates mid-run; the
  // probe then deletes itself and restores the spread.
  const sPark = await cdp.eval("window.__dua.state.spread");
  const stanzaBody =
    "Ashhadu Alla llaha Illallahu Wahdahu La Sharika Lahu Wa-ash-hadu\nWa Rasuluhu\n\n" +
    "La 'Hawla Wala\nQuwwata illa Billahil\n'Aliyyil 'Azeem\n\n" +
    "Third section after a blank line.";
  const stanzaId = await cdp.eval(
    `fetch('/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, ` +
      `body: ${JSON.stringify(JSON.stringify({ date: "2099-12-31", title: "Stanza probe", body: stanzaBody }))} })` +
      `.then((r) => r.json()).then((e) => e.id)`
  );
  assert(typeof stanzaId === "number" && stanzaId > 0, "stanza probe entry created");
  await cdp.eval(
    `fetch('/api/entries').then((r) => r.json()).then((a) => { window.__dua.state.entries = a; window.__dua.rerender(); })`
  );
  await sleep(400);
  assert(
    await cdp.eval(
      `(() => {
        const ps = [...document.querySelectorAll('.entry[data-id="${stanzaId}"] p')];
        const p1 = ps.find((x) => x.innerText.includes('Wa Rasuluhu'));
        const p2 = ps.find((x) => x.innerText.includes('Aliyyil'));
        return !!p1 && !!p2 &&
          p1.querySelectorAll('br').length === 1 &&
          p2.querySelectorAll('br').length === 2 &&
          p1.closest('.face') === p2.closest('.face');
      })()`
    ),
    "hard breaks render as forced lines and stanzas stay whole on one page"
  );
  assert(
    await cdp.eval(
      `(() => {
        const faces = [...document.querySelectorAll('.face.page')].filter((f) => f.querySelector('.entry[data-id="${stanzaId}"]'));
        return faces.length > 0 && faces.every((f) => { const b = f.querySelector('.page-body'); return b.scrollHeight - b.clientHeight <= 1; });
      })()`
    ),
    "hard-broken entry pages do not overflow"
  );
  // Notes spacing: lines sit flush left with no indent, sections are separated
  // by exactly one line box of gap, and the gap never leads a page. An empty
  // line the author typed (double Enter) is an intentional blank line and is
  // verified by the blank-line test below, not collapsed away here
  assert(
    await cdp.eval(
      `(() => {
        const ps = [...document.querySelectorAll('.entry[data-id="${stanzaId}"] p')];
        if (ps.length !== 3) return false;
        const same = ps.every((x) => x.closest('.face') === ps[0].closest('.face'));
        const cs0 = getComputedStyle(ps[0]);
        const fs = parseFloat(cs0.fontSize);
        const gaps = ps.slice(1).map((x) => parseFloat(getComputedStyle(x).marginTop));
        const firstP = ps[0].closest('.page-body').querySelector('p');
        return same &&
          cs0.textAlign === 'left' && cs0.textIndent === '0px' && cs0.hyphens === 'none' &&
          gaps.every((g) => Math.abs(g - 1.62 * fs) < 1.5) &&
          firstP === ps[0] &&
          parseFloat(getComputedStyle(firstP).marginTop) === 0;
      })()`
    ),
    "Notes spacing: flush-left, no indent, uniform one-line gaps, none leading a page"
  );
  await cdp.eval(`window.__dua.book.gotoEntry(${stanzaId})`);
  await sleep(500);
  await cdp.shot("qa/shots/13-hardbreak-desktop.png");
  await cdp.eval(`fetch('/api/entries/${stanzaId}', { method: 'DELETE' })`);
  await cdp.eval(
    `fetch('/api/entries').then((r) => r.json()).then((a) => { window.__dua.state.entries = a; window.__dua.rerender(); })`
  );
  await sleep(300);
  await cdp.eval(`window.__dua.book.gotoInstant(${sPark})`);
  await sleep(300);
  assert(
    (await count()) === 3 && (await cdp.eval("window.__dua.state.spread")) === sPark,
    "stanza probe cleaned itself up"
  );

  // edit a single-page entry on purpose (same reason as the delete below):
  // cdp.type replaces the focused paragraph, and clobbering the long entry's
  // first paragraph would shorten it out of the folio/edit-in-place tests
  const editId = await cdp.eval(`(() => {
    const ids = {};
    document.querySelectorAll(".entry").forEach((e) => (ids[e.dataset.id] = (ids[e.dataset.id] || 0) + 1));
    const k = Object.keys(ids).find((x) => ids[x] === 1);
    return k ? Number(k) : null;
  })()`);
  assert(editId !== null, "a single-page entry exists to double-click edit");
  await cdp.eval(`window.__dua.book.gotoEntry(${editId})`);
  await sleep(500);
  const sPreDbl = await cdp.eval("window.__dua.state.spread");
  // scope to the visible right-hand face: the same entry may also sit on an
  // earlier dormant face, and center() would click that one's rect
  await cdp.dblClickSel(`.face.cur-right .entry[data-id="${editId}"]`);
  assert(
    await cdp.waitFor(`window.__dua.state.editing === ${editId}`),
    "double-click edits entry"
  );
  await sleep(1400);
  assert(
    await cdp.eval(`window.__dua.state.spread === ${sPreDbl}`),
    "double-click edit jumps back to the entry it was aimed at"
  );
  await cdp.waitIdle();
  await cdp.type("Rewritten by firelight after the rain stopped.");
  await cdp.shot("qa/shots/05-edit-existing.png");
  await cdp.key("s", { modifiers: 2, text: "s" });
  await cdp.waitFor(`window.__dua.state.editing === null`);
  await cdp.waitIdle();
  assert(
    (await cdp.eval(
      `fetch('/api/entries').then(r=>r.json()).then(a=>a.find(e=>e.id===${editId}).body)`
    )).includes("firelight"),
    "update persisted"
  );

  // Enter is the author's blank line: each Enter splits the section right
  // where it is pressed, so two Enters leave text — empty line — new section,
  // and that double gap survives the save
  await cdp.dblClickSel(`.face.cur-right .entry[data-id="${editId}"]`);
  assert(
    await cdp.waitFor(`window.__dua.state.editing === ${editId}`),
    "re-edit opens for the blank-line test"
  );
  await sleep(1400);
  await cdp.waitIdle();
  // the editor suppresses Enter's text on keydown, as a real browser does —
  // noChar delivers that same suppressed keypress (a CDP char event would
  // bypass the suppression and inject a ghost newline the author never gets)
  await cdp.key("Enter", { noChar: true });
  await sleep(420);
  await cdp.key("Enter", { noChar: true });
  await sleep(420);
  await cdp.cmd("Runtime.evaluate", {
    expression: `document.execCommand('insertText', false, "Typed section after two Enters.")`,
  });
  await sleep(650);
  await cdp.waitIdle();
  assert(
    await cdp.waitFor(
      `(() => { const ps = [...document.querySelectorAll('.entry[data-id="${editId}"] p')]; return ps.length === 3 && ps[1].innerText.trim() === "" && ps[2].innerText.startsWith("Typed section"); })()`
    ),
    "two Enters leave text, a real empty line, then the new section"
  );
  await cdp.key("s", { modifiers: 2, text: "s" });
  await cdp.waitFor("window.__dua.state.editing === null");
  await cdp.waitIdle();
  assert(
    (await cdp.eval(
      `fetch('/api/entries').then(r=>r.json()).then(a=>a.find(e=>e.id===${editId}).body)`
    )).includes(JSON.parse('"\\n\\n\\n\\nTyped section after two Enters."')),
    "the intentional empty line persists to the server"
  );

  // the section gap itself must be deletable: each paragraph is its own
  // editable island, so Backspace at a section start has to merge the two
  // sections (Notes behavior) instead of hitting the island edge and dying
  await cdp.dblClickSel(`.face.cur-right .entry[data-id="${editId}"]`);
  assert(
    await cdp.waitFor(`window.__dua.state.editing === ${editId}`),
    "re-edit opens for the boundary-merge test"
  );
  await sleep(1400);
  await cdp.waitIdle();
  assert(
    await cdp.eval(`(() => {
      const ps = [...document.querySelectorAll('.entry[data-id="${editId}"] p')];
      return ps.filter((x) => x.innerText.trim()).length === 2 && ps.some((x) => x.innerText.startsWith("Typed section"));
    })()`),
    "two filled sections stand apart, with the intentional blank line between"
  );
  const placed = await cdp.eval(`(() => {
    const ps = [...document.querySelectorAll('.entry[data-id="${editId}"] p')];
    const p = ps.find((x) => x.innerText.startsWith("Typed section"));
    p.focus();
    const r = document.createRange();
    const n = p.firstChild || p;
    r.setStart(n.nodeType === 3 ? n : p, 0);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return document.activeElement === p && s.isCollapsed;
  })()`);
  assert(placed, "caret parked at the start of the later section");
  await cdp.key("Backspace");
  await sleep(700);
  await cdp.waitIdle();
  assert(
    await cdp.waitFor(`(() => {
      const ps = [...document.querySelectorAll('.entry[data-id="${editId}"] p')];
      return ps.length === 2 && ps[1].innerText.startsWith("Typed section");
    })()`),
    "first Backspace deletes the intentional blank line, the gap remains"
  );
  await cdp.key("Backspace");
  await sleep(700);
  await cdp.waitIdle();
  assert(
    await cdp.waitFor(`(() => {
      const ps = [...document.querySelectorAll('.entry[data-id="${editId}"] p')];
      return ps.length === 1 && ps[0].innerText.includes("stopped.Typed section");
    })()`),
    "second Backspace at a section start deletes the gap and merges the sections"
  );
  await cdp.shot("qa/shots/14-boundary-merge.png");
  await cdp.key("s", { modifiers: 2, text: "s" });
  await cdp.waitFor("window.__dua.state.editing === null");
  await cdp.waitIdle();
  assert(
    (await cdp.eval(
      `fetch('/api/entries').then(r=>r.json()).then(a=>a.find(e=>e.id===${editId}).body)`
    )).includes("stopped.Typed section"),
    "merged sections persist as one paragraph"
  );

  // Enter splits one merged paragraph exactly where it is pressed — the
  // author's Notes gap, live and persistent
  await cdp.dblClickSel(`.face.cur-right .entry[data-id="${editId}"]`);
  assert(
    await cdp.waitFor(`window.__dua.state.editing === ${editId}`),
    "re-edit opens for the Enter-split test"
  );
  await sleep(1400);
  await cdp.waitIdle();
  const atStop = await cdp.eval(`(() => {
    const ps = [...document.querySelectorAll('.entry[data-id="${editId}"] p')];
    const p = ps.find((x) => x.innerText.includes("stopped."));
    if (!p) return false;
    const tn = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes("stopped."));
    if (!tn) return false;
    p.focus();
    const r = document.createRange();
    r.setStart(tn, tn.textContent.indexOf("stopped.") + "stopped.".length);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return s.isCollapsed;
  })()`);
  assert(atStop, "caret parked right after 'stopped.'");
  await cdp.key("Enter", { noChar: true });
  await sleep(700);
  await cdp.waitIdle();
  assert(
    await cdp.waitFor(`(() => {
      const ps = [...document.querySelectorAll('.entry[data-id="${editId}"] p')];
      return ps.length === 2 && ps[0].innerText.trim().endsWith("stopped.") && ps[1].innerText.startsWith("Typed section");
    })()`),
    "one Enter splits the section right where it was pressed"
  );
  await cdp.shot("qa/shots/16-enter-split.png");
  await cdp.key("s", { modifiers: 2, text: "s" });
  await cdp.waitFor("window.__dua.state.editing === null");
  await cdp.waitIdle();
  assert(
    (await cdp.eval(
      `fetch('/api/entries').then(r=>r.json()).then(a=>a.find(e=>e.id===${editId}).body)`
    )).includes(JSON.parse('"stopped.\\n\\nTyped section after two Enters."')),
    "the gap created by Enter persists to the server"
  );

  const before = await count();
  // delete a single-page entry on purpose: the folio walk and the
  // edit-in-place test later on need the long (multi-page) entry to survive
  const shortId = await cdp.eval(`(() => {
    const ids = {};
    document.querySelectorAll(".entry").forEach((e) => (ids[e.dataset.id] = (ids[e.dataset.id] || 0) + 1));
    const k = Object.keys(ids).find((x) => ids[x] === 1);
    return k ? Number(k) : null;
  })()`);
  assert(shortId !== null, "a single-page entry exists to delete");
  await cdp.eval(`window.__dua.book.gotoEntry(${shortId})`);
  await sleep(500);
  await cdp.dblClickSel(`.face.cur-right .entry[data-id="${shortId}"]`);
  await sleep(900);
  await cdp.waitIdle();
  await cdp.clickSel('.icon-rail button[data-act="delete"]');
  await sleep(200);
  assert(
    await cdp.eval('document.querySelectorAll(".icon-rail button.armed").length >= 1'),
    "first delete click arms"
  );
  await cdp.shot("qa/shots/06-delete-armed.png");
  await cdp.clickSel('.icon-rail button[data-act="delete"]');
  await sleep(600);
  assert((await count()) === before - 1, "second delete click commits");

  await cdp.key("Escape");
  assert(
    await cdp.eval("window.__dua.state.spread === 0 && window.__dua.state.editing === null"),
    "escape from first spread closes the book"
  );
  // closing is an animated turn: wait out the busy window or the cover click
  // below lands on a busy book and is swallowed
  await cdp.waitIdle();

  await cdp.clickSel(".cover");
  await sleep(1100);
  await cdp.waitIdle();
  await cdp.key("End");
  await sleep(400);
  assert(
    await cdp.eval("window.__dua.state.spread === window.__dua.book.max"),
    "End jumps to last spread"
  );
  await cdp.shot("qa/shots/07-last-spread.png");

  await cdp.eval("window.__dua.book.gotoInstant(1)");
  await sleep(300);
  await cdp.click(12, 12);
  await sleep(950);
  await cdp.waitIdle();
  assert(await cdp.waitFor("window.__dua.state.spread === 0"), "left-half click closes the book");

  await cdp.cmd("Emulation.setDeviceMetricsOverride", {
    width: 420, height: 820, deviceScaleFactor: 1, mobile: true,
  });
  await cdp.eval("window.dispatchEvent(new Event('resize'))");
  await sleep(800);
  await cdp.shot("qa/shots/08-mobile-single.png");
  assert(
    await cdp.eval("window.__dua.book.single === true"),
    "phone viewport keeps the single page layout"
  );

  // left-half / right-half invisible turn zones (mobile viewport active)
  await cdp.clickSel(".cover");
  await sleep(1100);
  await cdp.waitIdle();
  const s0 = await cdp.eval("window.__dua.state.spread");
  await cdp.click(10, 400);
  await sleep(950);
  await cdp.waitIdle();
  assert(
    await cdp.eval(`window.__dua.state.spread === ${s0} - 1`),
    "left-half tap turns back to cover"
  );
  await cdp.clickSel(".cover");
  await sleep(1100);
  await cdp.waitIdle();
  await cdp.click(410, 400);
  await sleep(950);
  await cdp.waitIdle();
  assert(
    await cdp.eval(`window.__dua.state.spread === ${s0} + 1`),
    "right-half tap turns forward"
  );
  await cdp.click(10, 400);
  await sleep(950);
  await cdp.waitIdle();
  assert(
    await cdp.eval(`window.__dua.state.spread === ${s0}`),
    "left-half tap turns back"
  );

  // folio walk: every page number must actually pass through the viewport
  const onscreen = () => cdp.eval(`(() => {
    const els = document.elementsFromPoint(210, 440);
    const face = els.find((e) => e.classList && e.classList.contains("face") && e.classList.contains("page"));
    return face ? (face.querySelector(".folio") || {}).textContent ?? null : null;
  })()`);
  assert((await onscreen()) === "1", "mobile viewport shows page 1");
  await cdp.click(410, 400);
  await sleep(950);
  await cdp.waitIdle();
  assert((await onscreen()) === "2", "after one turn: page 2 (no skipping)");
  await cdp.click(410, 400);
  await sleep(950);
  await cdp.waitIdle();
  const f3 = await onscreen();
  assert(f3 === "3", `after two turns: page 3 (got ${f3})`);
  await cdp.click(10, 400);
  await sleep(950);
  await cdp.waitIdle();
  assert((await onscreen()) === "2", "one turn back: page 2");
  await cdp.shot("qa/shots/10-mobile-verso.png");

  // index overlay + fast travel
  const entryCount = await count();
  await cdp.key("i");
  await sleep(300);
  assert(
    await cdp.eval("!document.getElementById('index-overlay').hidden"),
    "i opens the index overlay"
  );
  assert(
    (await cdp.eval("document.querySelectorAll('#index-list li').length")) === entryCount,
    `index lists all ${entryCount} entries`
  );
  await cdp.shot("qa/shots/09-index-mobile.png");
  await cdp.eval(`(() => {
    document.getElementById('index-page').value = String(window.__dua.book.maxPage());
  })()`);
  await cdp.clickSel("#index-go-btn");
  await sleep(400);
  assert(
    await cdp.eval(`(() => {
      const i = window.__dua.book.faceIndexByPage(window.__dua.book.maxPage());
      return window.__dua.state.spread === Math.ceil(i / 2) &&
        document.getElementById('index-overlay').hidden;
    })()`),
    "fast travel jumps to last page and closes index"
  );
  await cdp.key("i");
  await sleep(300);
  await cdp.clickSel("#index-list li");
  await sleep(400);
  assert(
    await cdp.eval(`(() => {
      const first = window.__dua.state.entries.filter(e => !e.draft)[0];
      const i = window.__dua.book.faceIndexWithEntry(first.id);
      return window.__dua.state.spread === Math.ceil(i / 2) &&
        document.getElementById('index-overlay').hidden;
    })()`),
    "index row click travels to that entry"
  );

  // edit-in-place for a multi-page entry: the phone scenario where the author
  // stands on page 2 of a long entry, edits, flips to keep writing, saves.
  // a tail entry first: the long entry's last page must not be the max spread
  await cdp.eval(`fetch('/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2099-01-01', title: 'Tail', body: 'A short tail entry so there are always pages after the long one.' }) })`);
  await cdp.eval(`fetch('/api/entries').then(r=>r.json()).then(a=>{ window.__dua.state.entries = a; window.__dua.rerender(); })`);
  await sleep(400);
  const longId = await cdp.eval(`(() => {
    const ids = {};
    document.querySelectorAll(".entry").forEach((e) => (ids[e.dataset.id] = (ids[e.dataset.id] || 0) + 1));
    const k = Object.keys(ids).find((x) => ids[x] >= 2);
    return k ? Number(k) : null;
  })()`);
  assert(longId !== null, "a multi-page entry exists for the edit-in-place test");
  const s2 = await cdp.eval(`(() => {
    const faces = window.__dua.book.faces;
    let seen = 0;
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      if (f.kind === "page" && f.page.entryId === ${longId}) {
        seen++;
        if (seen === 2) {
          const s = Math.ceil(i / 2);
          window.__dua.book.gotoInstant(s);
          return s;
        }
      }
    }
    return null;
  })()`);
  await sleep(300);
  assert(s2 !== null && (await cdp.eval(`window.__dua.state.spread === ${s2}`)), "parked on page two of the long entry");
  const pencilBox = await cdp.eval(`(() => {
    for (const f of document.querySelectorAll(".face.cur-right, .face.cur-left")) {
      const pen = f.querySelector('.pencil[data-id="${longId}"]');
      if (pen) {
        const r = pen.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  })()`);
  assert(pencilBox !== null, "pencil is visible on the second page");
  await cdp.click(pencilBox.x, pencilBox.y);
  assert(await cdp.waitFor(`window.__dua.state.editing === ${longId}`), "pencil on page two opens the editor");
  assert(
    await cdp.eval(`window.__dua.state.spread === ${s2}`),
    "edit mode stays on the page being edited (no jump to the first page)"
  );
  assert(
    await cdp.eval(`(() => { const a = document.activeElement; return !!a && !!a.closest(".entry") && Number(a.closest(".entry").dataset.id) === ${longId}; })()`),
    "caret starts inside the entry on the edited page"
  );
  const facesBefore = await cdp.eval(`document.querySelectorAll('.entry[data-id="${longId}"]').length`);
  await cdp.cmd("Runtime.evaluate", {
    expression: `document.execCommand('insertText', false, " continuation typed on the second page")`,
  });
  await sleep(900);
  assert(await cdp.eval(`window.__dua.state.editing === ${longId}`), "the live reflow keeps the edit open");
  assert(
    await cdp.eval(`(() => { const arts = [...document.querySelectorAll('.entry[data-id="${longId}"]')]; return arts[arts.length - 1].innerText.includes("second page"); })()`),
    "the overflow reflows onto the entry's next page while still editing"
  );
  assert(
    await cdp.eval(`(() => { const els = document.elementsFromPoint(210, 440); const face = els.find(e => e.classList && e.classList.contains("face")); return !!face && face.innerText.includes("second page"); })()`),
    "the book follows the writing: continuation is on screen"
  );
  const pages =
    "The lantern hissed. Outside the rain took over the whole courtyard, drumming on the tiles, " +
    "rattling the shutters, gathering in the gutters and off the leaking edge of the awning where " +
    "the cat had slept through the first grumble of thunder. I thought of the gate latch, of lentils " +
    "and bread, of every unfinished thing the day had left standing in corners. The rain kept its own " +
    "counsel all night, and by morning the courtyard was a shallow lake reflecting a washed sky. " +
    "I wrote all of this by the window while the last drops still fell, one by one, like a thought " +
    "that refuses to end, and then a little more, so the page could not hold it.";
  await cdp.cmd("Runtime.evaluate", {
    expression: `document.execCommand('insertText', false, ${JSON.stringify(" " + pages.repeat(3))})`,
  });
  await sleep(900);
  const facesAfter = await cdp.eval(`document.querySelectorAll('.entry[data-id="${longId}"]').length`);
  assert(
    facesAfter > facesBefore,
    "writing past every page grows the entry new pages live (no save needed)"
  );
  await cdp.shot("qa/shots/11-mobile-edit-page2.png");
  const sLive = await cdp.eval("window.__dua.state.spread");
  await cdp.click(410, 400);
  await sleep(950);
  await cdp.waitIdle();
  assert(
    await cdp.eval(`window.__dua.state.spread === ${sLive} + 1`),
    "right-half tap flips the book while editing"
  );
  assert(await cdp.eval(`window.__dua.state.editing === ${longId}`), "the edit session survives the flip");
  await cdp.shot("qa/shots/12-mobile-edit-flipped.png");
  await cdp.click(10, 400);
  await sleep(950);
  await cdp.waitIdle();
  await cdp.key("s", { modifiers: 2, text: "s" });
  assert(await cdp.waitFor("window.__dua.state.editing === null"), "ctrl+s saves the multi-page edit");
  const savedLong = await cdp.eval(
    `fetch('/api/entries').then(r=>r.json()).then(a=>a.find(e=>e.id===${longId}).body)`
  );
  assert(savedLong.includes("continuation typed on the second page"), "continuation text saved into the entry");
  assert(
    await cdp.eval(`window.__dua.state.spread === ${sLive}`),
    "save keeps the author on the page they were writing (no jump back to page one)"
  );

  const exportJson = await (await fetch(APP_URL + "api/export")).json();
  assert(exportJson.entries.length === await count(), "export snapshot matches live count");

  // the same gap-delete on the phone viewport, opened with the pencil — the
  // iPhone author's actual path — merged straight to the server
  await cdp.eval(`fetch('/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2099-02-02', title: 'Seam', body: 'Alpha one two three.\\n\\nBeta four five six.' }) })`);
  await cdp.eval(`fetch('/api/entries').then(r=>r.json()).then(a=>{ window.__dua.state.entries = a; window.__dua.rerender(); })`);
  await sleep(400);
  const seamId = await cdp.eval(`window.__dua.state.entries.find(e => e.title === "Seam").id`);
  await cdp.eval(`window.__dua.book.gotoEntry(${seamId})`);
  await cdp.waitIdle();
  const pen = await cdp.eval(`(() => {
    for (const f of document.querySelectorAll(".face.cur-right, .face.cur-left")) {
      const pe = f.querySelector('.pencil[data-id="${seamId}"]');
      if (pe) { const r = pe.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    }
    return null;
  })()`);
  assert(pen !== null, "pencil visible on the seam entry (phone)");
  await cdp.click(pen.x, pen.y);
  assert(await cdp.waitFor(`window.__dua.state.editing === ${seamId}`), "pencil opens the edit on phone");
  await sleep(1200);
  await cdp.waitIdle();
  const parked = await cdp.eval(`(() => {
    const ps = [...document.querySelectorAll('.entry[data-id="${seamId}"] p')];
    const p = ps.find((x) => x.innerText.startsWith("Beta"));
    if (!p) return false;
    p.focus();
    const r = document.createRange();
    const n = p.firstChild || p;
    r.setStart(n.nodeType === 3 ? n : p, 0);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return document.activeElement === p && s.isCollapsed;
  })()`);
  assert(parked, "caret parked at the start of Beta on the phone edit");
  await cdp.key("Backspace");
  await sleep(700);
  await cdp.waitIdle();
  assert(
    await cdp.waitFor(`(() => {
      const ps = [...document.querySelectorAll('.entry[data-id="${seamId}"] p')];
      return ps.length === 1 && ps[0].innerText.includes("three.Beta four");
    })()`),
    "phone: Backspace merges the sections across the gap"
  );
  await cdp.shot("qa/shots/15-boundary-merge-phone.png");
  await cdp.key("s", { modifiers: 2, text: "s" });
  await cdp.waitFor("window.__dua.state.editing === null");
  await cdp.waitIdle();
  assert(
    (await cdp.eval(
      `fetch('/api/entries').then(r=>r.json()).then(a=>a.find(e=>e.id===${seamId}).body)`
    )).includes("three.Beta four"),
    "phone merge persists to the server"
  );

  // Enter behaves the same on the phone viewport, through the pencil — the
  // iPhone author's actual path — splitting where pressed, persisted to server
  const pen2 = await cdp.eval(`(() => {
    for (const f of document.querySelectorAll(".face.cur-right, .face.cur-left")) {
      const pe = f.querySelector('.pencil[data-id="${seamId}"]');
      if (pe) { const r = pe.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    }
    return null;
  })()`);
  assert(pen2 !== null, "pencil visible again on the seam entry");
  await cdp.click(pen2.x, pen2.y);
  assert(await cdp.waitFor(`window.__dua.state.editing === ${seamId}`), "pencil re-opens the seam edit (phone)");
  await sleep(1200);
  await cdp.waitIdle();
  const atThree = await cdp.eval(`(() => {
    const ps = [...document.querySelectorAll('.entry[data-id="${seamId}"] p')];
    const p = ps.find((x) => x.innerText.includes("three."));
    if (!p) return false;
    const tn = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes("three."));
    if (!tn) return false;
    p.focus();
    const r = document.createRange();
    r.setStart(tn, tn.textContent.indexOf("three.") + "three.".length);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return s.isCollapsed;
  })()`);
  assert(atThree, "caret parked after 'three.' on the phone edit");
  await cdp.key("Enter", { noChar: true });
  await sleep(700);
  await cdp.waitIdle();
  assert(
    await cdp.waitFor(`(() => {
      const ps = [...document.querySelectorAll('.entry[data-id="${seamId}"] p')];
      return ps.length === 2 && ps[0].innerText.trim().endsWith("three.") && ps[1].innerText.startsWith("Beta");
    })()`),
    "phone: one Enter splits the section right where it was pressed"
  );
  await cdp.shot("qa/shots/17-enter-split-phone.png");
  await cdp.key("s", { modifiers: 2, text: "s" });
  await cdp.waitFor("window.__dua.state.editing === null");
  await cdp.waitIdle();
  assert(
    (await cdp.eval(
      `fetch('/api/entries').then(r=>r.json()).then(a=>a.find(e=>e.id===${seamId}).body)`
    )).includes(JSON.parse('"three.\\n\\nBeta"')),
    "phone gap created by Enter persists to the server"
  );

  // A no-op edit must not rewrite the author's words, byte for byte. Two
  // hazards cover it: a section longer than a page (the paginator splits it at
  // a word, and that seam must never be saved as a blank line) and a stanza
  // with hard breaks on a page that is not on screen (display:none makes
  // innerText drop every <br>).
  const longProse = Array.from({ length: 240 }, (_, i) => `filler${i}`).join(" ");
  const stanza = "first hard-broken line\nsecond hard-broken line\nthird hard-broken line";
  const ghostBody = `${longProse}\n\n${stanza}\n\n${longProse.split(" ").reverse().join(" ")}`;
  const ghostId = await cdp.eval(
    `fetch('/api/entries', { method: 'POST', headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ date: null, title: '', name: '', body: ${JSON.stringify(ghostBody)} }) })
     .then(r => r.json()).then(e => e.id)`
  );
  await cdp.eval(`(async () => {
    const D = window.__dua;
    D.state.entries = await (await fetch('/api/entries')).json();
    D.rerender();
    while (D.book.busy) await new Promise((r) => setTimeout(r, 60));
  })()`);
  await cdp.waitIdle();
  const seamCount = await cdp.eval(
    `(() => {
      const D = window.__dua;
      D.editor.enter(${ghostId});
      return {
        paragraphs: document.querySelectorAll('.entry[data-id="${ghostId}"] p').length,
        seams: document.querySelectorAll('.entry[data-id="${ghostId}"] [data-cont]').length,
      };
    })()`
  );
  assert(seamCount.paragraphs > 3, "long entry paginates into several paragraphs");
  assert(seamCount.seams >= 2, "page seams inside one section are marked as continuations");
  await cdp.key("s", { modifiers: 2, text: "s" });
  await cdp.waitFor("window.__dua.state.editing === null");
  await cdp.waitIdle();
  const afterNoopEdit = await cdp.eval(
    `fetch('/api/entries').then(r=>r.json()).then(a=>a.find(e=>e.id===${ghostId}).body)`
  );
  assert(
    afterNoopEdit === ghostBody,
    `opening and saving an entry leaves its text byte-identical (${ghostBody.length} → ${
      afterNoopEdit.length
    } chars, ${ghostBody.split("\n\n").length} → ${afterNoopEdit.split("\n\n").length} sections)`
  );

  // --- a picture is a block -------------------------------------------------
  // Three media lines inside one entry: they arrive as pictures without
  // disturbing the words around them, and one of a *run* of them — which has no
  // text beside it to Backspace from — comes away with a click plus a delete
  // key, storing exactly its own line gone.
  const picBody =
    "text before the pictures\n\nmedia/p1.png\n\nmedia/p2.png\n\nmedia/p3.png\n\ntext after the pictures";
  const picId = await cdp.eval(
    `fetch('/api/entries', { method: 'POST', headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ date: null, title: '', name: '', body: ${JSON.stringify(picBody)} }) })
     .then(r => r.json()).then(e => e.id)`
  );
  await cdp.eval(`(async () => {
    const D = window.__dua;
    D.state.entries = await (await fetch('/api/entries')).json();
    D.rerender();
    while (D.book.busy) await new Promise((r) => setTimeout(r, 60));
  })()`);
  await cdp.waitIdle();
  // the <img> elements only know their size once the bytes have decoded
  await cdp.waitFor(
    `[...document.querySelectorAll('.entry[data-id="${picId}"] .e-media img')].every(
      (i) => i.complete && i.naturalWidth > 0
    )`,
    8000
  );
  const shown = await cdp.eval(
    `(() => {
      const imgs = [...document.querySelectorAll('.entry[data-id="${picId}"] .e-media img')];
      return { pictures: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
               editable: [...document.querySelectorAll('.entry[data-id="${picId}"] .e-media')]
                 .some((el) => el.isContentEditable) };
    })()`
  );
  assert(
    shown.pictures === 3 && shown.loaded === 3 && shown.editable === false,
    `the three media lines become three decoded, non-editable pictures (${JSON.stringify(shown)})`
  );

  // stand wherever the run is visible, then edit it
  const centreOf = (n) =>
    cdp.eval(
      `(async () => {
        const b = window.__dua.book;
        for (let s = 1; s <= b.max; s++) {
          b.gotoInstant(s);
          await new Promise((r) => setTimeout(r, 12));
          const media = [...document.querySelectorAll(".face")]
            .filter((f) => !f.closest(".leaf.dormant"))
            .flatMap((f) => [...f.querySelectorAll('.entry[data-id="${picId}"] .e-media')]);
          if (media.length > ${n}) {
            const r = media[${n}].getBoundingClientRect();
            return { spread: s, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          }
        }
        return null;
      })()`
    );
  await centreOf(1);
  await cdp.eval(`window.__dua.editor.enter(${picId})`);
  await cdp.waitIdle();
  const spot = await centreOf(1);
  assert(spot !== null, "the run of pictures can be brought on screen");
  await cdp.click(spot.x, spot.y);
  await sleep(150);
  const armedState = await cdp.eval(
    `(() => {
      const a = document.querySelector(".e-media.armed");
      return { armed: a ? a.dataset.src : null, editable: a ? a.isContentEditable : null,
               caretInText: !!window.__dua.editor.caretParagraph() };
    })()`
  );
  await cdp.shot("qa/shots/17-picture-armed.png");
  assert(
    armedState.armed === "media/p2.png" && armedState.editable === false && !armedState.caretInText,
    `clicking a picture arms it for removal, caret and page turn untouched (${JSON.stringify(armedState)})`
  );
  await cdp.key("Backspace");
  await cdp.waitIdle();
  await cdp.key("s", { modifiers: 2, text: "s" });
  await cdp.waitFor("window.__dua.state.editing === null");
  await cdp.waitIdle();
  const picSaved = await cdp.eval(
    `fetch('/api/entries').then(r=>r.json()).then(a=>a.find(e=>e.id===${picId}).body)`
  );
  assert(
    picSaved === "text before the pictures\n\nmedia/p1.png\n\nmedia/p3.png\n\ntext after the pictures",
    `removing one picture out of a run stores exactly its own line gone (${JSON.stringify(picSaved)})`
  );

  cdp.close();
  chrome.kill();
} finally {
  server.kill();
  if (chrome) chrome.kill();
}
console.log(process.exitCode ? "WORKFLOW FAILED" : "WORKFLOW PASSED");

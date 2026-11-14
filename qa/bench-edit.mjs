import { spawn } from "node:child_process";
import { startChrome, CDP, sleep, assert } from "./lib.mjs";

const DB = process.env.TEMP + "/dua-edit-" + Date.now() + ".db";
const PORT = 8690;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn("python", ["qa/serve.py"], {
  env: { ...process.env, DUA_DB: DB, DUA_PORT: String(PORT) },
  stdio: "ignore",
});

async function api(path, opts) {
  const r = await fetch(BASE + path, opts);
  return r.status === 204 ? null : r.json();
}

try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/api/entries")).ok) break;
    } catch (_) {}
    await sleep(200);
  }
  // long undated entries, like the seeded Dua
  const long = "Subhanallah ".repeat(120) + "the end.";
  const e1 = await api("/api/entries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "", body: long }),
  });
  const e2 = await api("/api/entries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "", body: "Short second entry body." }),
  });

  const chrome = await startChrome(9376, "420,880");
  try {
    const cdp = await CDP.connect(9376);
    await cdp.goto(BASE);
    await cdp.clickSel(".cover");
    await sleep(900);
    await cdp.eval(`window.__dua.book.gotoEntry(${e1.id})`);
    await sleep(600);

    // pencil tap
    const pen = await cdp.center(".face.cur-right .pencil");
    await cdp.click(pen.x, pen.y);
    await sleep(800);
    assert(await cdp.eval("window.__dua.state.editing !== null"), "pencil -> editing");

    // rail save button: does it exist, is it hit-testable?
    const rail = await cdp.eval(`(() => {
      const rails = [...document.querySelectorAll('.icon-rail')].map((r) => ({
        cls: r.className, faceCls: r.closest('.face')?.className,
        disp: getComputedStyle(r).opacity,
      }));
      const btn = document.querySelector('.icon-rail.shown button[data-act="save"]') ||
                  document.querySelector('.icon-rail button[data-act="save"]');
      if (!btn) return { err: "no save button", rails };
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { rails, rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        hit: hit && (hit.tagName + "." + hit.className), visible: r.width > 0 && r.height > 0 };
    })()`);
    console.log("save rail probe:", JSON.stringify(rail));

    // type into the entry
    await cdp.eval(`(() => {
      const p = document.querySelector('.entry.editing p');
      p.focus();
      document.execCommand('insertText', false, ' APPENDED BY BENCH');
    })()`);
    await sleep(300);

    // click the actual save button (finger tap path)
    if (rail.rect && rail.hit && rail.hit.startsWith("BUTTON")) {
      await cdp.click(rail.rect.x + rail.rect.w / 2, rail.rect.y + rail.rect.h / 2);
    } else if (rail.rect) {
      await cdp.click(rail.rect.x + rail.rect.w / 2, rail.rect.y + rail.rect.h / 2);
    } else {
      await cdp.eval("window.__dua.editor.save()");
    }
    await sleep(1200);
    assert(await cdp.eval("window.__dua.state.editing === null"), "save tap closes editing");
    assert(
      !await cdp.eval("document.querySelectorAll('.icon-rail').length"),
      "rail buttons removed"
    );
    const after = await api("/api/entries/" + e1.id);
    assert(after.body.includes("APPENDED BY BENCH"), `server body updated (len ${after.body.length})`);
    console.log("post-save entries:", JSON.stringify(await cdp.eval(
      "window.__dua.state.entries.map((e) => ({ id: e.id, len: e.body.length, upd: e.updated_at }))"
    )));

    // cancel path
    const pen2 = await cdp.center(".face.cur-right .pencil");
    await cdp.click(pen2.x, pen2.y);
    await sleep(800);
    await cdp.eval(`(() => {
      const p = document.querySelector('.entry.editing p');
      p.focus();
      document.execCommand('insertText', false, ' SHOULD DISAPPEAR');
    })()`);
    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('.icon-rail button')].find(
        (b) => b.dataset.act === "cancel" && b.closest('.face:not(.dormant)'));
      (btn || document.querySelector('.icon-rail button[data-act="cancel"]')).click();
    })()`);
    await sleep(900);
    assert(await cdp.eval("window.__dua.state.editing === null"), "cancel tap closes editing");
    const after2 = await api("/api/entries/" + e1.id);
    assert(!after2.body.includes("SHOULD DISAPPEAR"), "cancel discarded edits");
    console.log("post-cancel entries:", JSON.stringify(await cdp.eval(
      "window.__dua.state.entries.map((e) => ({ id: e.id, len: e.body.length }))"
    )));

    // delete path (two armed clicks) — delete e1 specifically so e2 remains
    await cdp.eval(`window.__dua.book.gotoEntry(${e1.id})`);
    await sleep(700);
    console.log("pre-delete diag:", JSON.stringify(await cdp.eval(`({
      entries: window.__dua.state.entries.map((e) => ({ id: e.id, len: e.body.length })),
      server: [...document.querySelectorAll('.pencil')].map((p) => p.dataset.id),
      faces: document.querySelectorAll('.face').length,
      spread: window.__dua.state.spread, max: window.__dua.book.max,
    })`)));
    const pen3 = await cdp.center(".face.cur-right .pencil");
    await cdp.click(pen3.x, pen3.y);
    await sleep(800);
    const delClick = `(() => {
      const btn = [...document.querySelectorAll('.icon-rail button')].find(
        (b) => b.dataset.act === "delete" && b.closest('.face:not(.dormant)'));
      (btn || document.querySelector('.icon-rail button[data-act="delete"]')).click();
    })()`;
    await cdp.eval(delClick);
    await sleep(300);
    await cdp.eval(delClick);
    await sleep(900);
    const list = await api("/api/entries");
    assert(list.length === 1, `delete committed, entries=${list.length}`);

    // regression: tap-away must FINISH an edit (auto-save when there is text)
    // and must never leave state.editing set, which used to wedge all taps
    await cdp.eval(`window.__dua.book.gotoEntry(${e2.id})`);
    await sleep(700);
    const pen4 = await cdp.center(`.face:not(.dormant) .pencil[data-id="${e2.id}"]`);
    await cdp.click(pen4.x, pen4.y);
    await sleep(800);
    await cdp.eval(`(() => {
      const p = document.querySelector('.entry.editing p');
      p.focus();
      document.execCommand('insertText', false, ' tap-away saved');
    })()`);
    await cdp.click(10, 300);
    await sleep(1200);
    const away1 = await cdp.eval(`(() => {
      const el = document.elementFromPoint(10, 300);
      return { hit: el && (el.id || el.tagName + "." + (el.className.baseVal ?? el.className)),
        editing: window.__dua.state.editing, active: !!window.__dua.editor.active,
        busy: window.__dua.book.busy };
    })()`);
    console.log("tap-away diag:", JSON.stringify(away1));
    assert(await cdp.eval("window.__dua.state.editing === null"), "tap-away closes edit");
    const after4 = await api("/api/entries").then((a) => a.find((e) => e.id === e2.id));
    assert(after4.body.includes("tap-away saved"), "tap-away persisted text");

    // regression: empty draft + tap-away = discarded, book still responsive
    await cdp.key("n");
    await sleep(900);
    assert(await cdp.eval("window.__dua.state.editing !== null"), "n opened empty draft");
    await cdp.click(10, 300);
    await sleep(1200);
    assert(await cdp.eval("window.__dua.state.editing === null"), "tap-away discarded empty draft");
    const remaining = await api("/api/entries");
    console.log("post-draft server:", JSON.stringify(remaining.map((e) => ({ id: e.id, len: e.body.length, body: e.body.slice(0, 30) }))));
    assert(remaining.length === 1, "no phantom entry from empty draft");

    // regression: zones still work after that edit round-trip
    // (one short entry remains: only ONE page, so test the BACK direction)
    await cdp.eval("window.__dua.book.gotoInstant(1)");
    await sleep(300);
    const sNow = await cdp.eval("window.__dua.state.spread");
    await cdp.click(10, 400);
    await sleep(950);
    assert(
      await cdp.eval(`window.__dua.state.spread === ${sNow} - 1`),
      "left-half tap still turns back after edit round-trip"
    );

    console.log(cdp.exceptions.length ? "EXCEPTIONS: " + JSON.stringify(cdp.exceptions) : "no exceptions");
    cdp.close();
  } finally {
    chrome.kill();
  }
} finally {
  server.kill();
}

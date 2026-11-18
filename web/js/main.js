import { state } from "./state.js?v=20261118c";
import { api } from "./api.js?v=20261118c";
import { computePages, onMediaAspects } from "./layout.js?v=20261118c";
import { book } from "./book.js?v=20261118c";
import { editor } from "./editor.js?v=20261118c";
import { indexPanel } from "./index.js?v=20261118c";

const offlineEl = document.getElementById("offline");
const stage = document.getElementById("stage");

let lastSingle = null;
// declared before use: the click/dblclick handlers below close over this
let lastTap = { id: null, t: 0, type: "" };

function setOffline(v) {
  state.offline = v;
  offlineEl.hidden = !v;
}

function rerender() {
  const geom = book.geom();
  if (lastSingle !== null && geom.single !== lastSingle) {
    book.gotoInstant(Math.min(state.spread, 1));
  }
  lastSingle = geom.single;
  const pages = computePages(state.entries, geom.colH, geom.colW);
  book.build(pages, geom);
  if (indexPanel.visible) indexPanel.render();
}

// A picture's true height is only known once its file has decoded, so the
// first paint may have measured it with the assumed ratio: re-paginate for the
// corrected breaks. Never under an open edit — that rebuilds the DOM out from
// under the caret (same guard as the resize handler); finishing the edit
// rerenders anyway.
onMediaAspects(() => {
  if (state.editing) return;
  rerender();
});

async function boot() {
  editor.init({ rerender, setOffline });
  try {
    state.entries = await api.list();
    setOffline(false);
  } catch (err) {
    state.entries = [];
    setOffline(true);
  }
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  rerender();
  window.__dua = { state, book, editor, rerender };
  window.__duaReady = true;
}

function openBook() {
  return book.open();
}

const waitBookIdle = async () => {
  while (book.busy) await new Promise((r) => setTimeout(r, 150));
};

stage.addEventListener("click", async (e) => {
  if (book.busy) return;

  const railBtn = e.target.closest(".icon-rail button");
  if (railBtn) {
    if (!railBtn.closest(".icon-rail").dataset.id) return;
    editor.railAction(railBtn);
    return;
  }
  if (state.editing) {
    const armed = book.el.querySelector(".icon-rail button.armed");
    if (armed && !e.target.closest(".icon-rail")) {
      armed.classList.remove("armed");
      return;
    }
    if (e.target.closest(".icon-rail") || e.target.closest(".entry.editing")) return;
    // tapping away from the edited text flips the book (same 50/50 zones as
    // reading): a multi-page entry is edited where the author stands; saving
    // and finishing happen on the per-page rails. The book never closes under
    // an open edit — the first spread is the back stop.
    const dir = e.clientX < window.innerWidth / 2 ? -1 : 1;
    if (dir < 0 && state.spread <= 1) return;
    if (book.turn(dir)) editor.focusSpread();
    return;
  }
  if (e.target.closest(".invitation")) {
    if (state.spread === 0) {
      openBook();
      await waitBookIdle();
    }
    editor.enter(null);
    return;
  }
  const pencil = e.target.closest(".pencil");
  if (pencil) {
    editor.enter(Number(pencil.dataset.id));
    return;
  }
  const cover = e.target.closest(".cover");
  if (cover && state.spread === 0) {
    openBook();
    return;
  }
  if (state.spread === 0) return;

  // invisible 50/50 zones: left half of the screen turns back, right forward.
  // Taps turn immediately; double-click-to-edit is for mouse devices only
  // (touch users get the visible pencil). We remember the tapped entry so a
  // double-click edits the entry the user aimed at, even after click 1 turned.
  const art = e.target.closest(".entry");
  const pointerType =
    e.pointerType || (window.matchMedia("(hover: hover)").matches ? "mouse" : "touch");
  // keep the spread from before the first click of a double-click pair so
  // dblclick-to-edit can flip back to exactly the page the mouse aimed at
  const pairSpread = lastTap && Date.now() - lastTap.t < 500 ? lastTap.s : state.spread;
  lastTap = { id: art ? Number(art.dataset.id) : null, t: Date.now(), type: pointerType, s: pairSpread };
  const dir = e.clientX < window.innerWidth / 2 ? -1 : 1;
  book.turn(dir);
});

stage.addEventListener("dblclick", async (e) => {
  if (state.editing) return;
  if (lastTap.type !== "mouse") return; // touch devices edit via the pencil
  if (!lastTap.id) return;
  const id = lastTap.id;
  const deadline = Date.now() + 2500;
  while (book.busy && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
  }
  if (book.busy) return;
  if (typeof lastTap.s === "number" && state.spread !== lastTap.s) book.gotoInstant(lastTap.s);
  editor.enter(id);
});

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const inField = e.target.isContentEditable;

  if (state.editing) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      editor.save();
      return;
    }
    if (e.key === "Escape") {
      const armed = book.el.querySelector(".icon-rail button.armed");
      if (armed) armed.classList.remove("armed");
      else editor.cancel();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "ArrowRight" && book.turn(1)) editor.focusSpread();
    if ((e.ctrlKey || e.metaKey) && e.key === "ArrowLeft" && state.spread > 1 && book.turn(-1)) editor.focusSpread();
    return;
  }
  if (inField) return;

  if (indexPanel.visible) {
    if (e.key === "Escape") indexPanel.hide();
    return;
  }

  const k = e.key;
  if (state.spread === 0) {
    if (k === "Enter" || k === " ") {
      e.preventDefault();
      openBook();
    }
    if (k === "i" || k === "I") indexPanel.toggle();
    return;
  }
  if (k === "ArrowRight" || k === " " || k === "PageDown") {
    e.preventDefault();
    book.turn(1);
  } else if (k === "ArrowLeft" || k === "PageUp") {
    e.preventDefault();
    book.turn(-1);
  } else if (k === "End") {
    book.gotoInstant(book.max);
  } else if (k === "Home") {
    book.close();
  } else if (k === "Escape") {
    book.close();
  } else if (k === "n" || k === "N") {
    editor.suppressChar = true;
    editor.enter(null);
  } else if (k === "e" || k === "E") {
    const ids = book.entriesOnSpread();
    if (ids.length) {
      editor.suppressChar = true;
      editor.enter(ids[0]);
    }
  } else if (k === "i" || k === "I") {
    indexPanel.toggle();
  }
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.editing) return;
    rerender();
  }, 250);
});

// the page is a fixed viewport: the book never scrolls. iOS still tries to
// scroll-into-view when a contenteditable gains focus — snap right back
window.addEventListener("scroll", () => window.scrollTo(0, 0), { passive: true });

// if iOS/macOS paused our timers while the tab was hidden, heal on return
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") book.recover();
});

boot();

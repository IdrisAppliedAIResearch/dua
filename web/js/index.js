// Scrollable index overlay + fast travel by page number.
// Names are the separate `name` column (or title, or first words as fallback);
// entry bodies are never touched here.
import { state } from "./state.js?v=20261118c";
import { mediaSrc } from "./layout.js?v=20261118c";
import { book } from "./book.js?v=20261118c";
import { editor } from "./editor.js?v=20261118c";

const tab = document.getElementById("index-tab");
const overlay = document.getElementById("index-overlay");
const list = document.getElementById("index-list");
const pageInput = document.getElementById("index-page");
const goBtn = document.getElementById("index-go-btn");
const newBtn = document.getElementById("index-new");
const closeBtn = document.getElementById("index-close");
const scrollEl = document.getElementById("index-scroll");

// a flick of the list followed by a stray touch must not count as choosing
// an entry — that is how users get "glitched" to the bottom of the book
let lastScroll = 0;
scrollEl.addEventListener("scroll", () => {
  lastScroll = Date.now();
});
const justScrolled = () => Date.now() - lastScroll < 350;

export function entryLabel(entry) {
  if (entry.name && entry.name.trim()) return entry.name.trim();
  if (entry.title && entry.title.trim()) return entry.title.trim();
  // a picture's file line is not words to read out: skip those sections
  const words = (entry.body || "")
    .split(/\n[ \t\u00a0]*\n/)
    .filter((s) => !mediaSrc(s))
    .join("\n\n")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(" ");
  return words + "…";
}

export const indexPanel = {
  get visible() {
    return !overlay.hidden;
  },
  show() {
    this.render();
    overlay.hidden = false;
  },
  hide() {
    overlay.hidden = true;
    pageInput.value = "";
    pageInput.blur();
  },
  toggle() {
    if (this.visible) this.hide();
    else this.show();
  },
  render() {
    list.textContent = "";
    for (const entry of state.entries) {
      if (entry.draft) continue;
      const i = book.faceIndexWithEntry(entry.id);
      if (i < 0) continue;
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "idx-name";
      name.textContent = entryLabel(entry);
      const page = document.createElement("span");
      page.className = "idx-page";
      page.textContent = book.faces[i].num;
      li.append(name, page);
      li.addEventListener("click", () => {
        if (justScrolled()) return;
        this.jumpToFace(i);
      });
      list.append(li);
    }
  },
  jumpToFace(i) {
    book.gotoInstant(Math.ceil(i / 2));
    this.hide();
  },
  go() {
    // strict travel: only a bare page number counts; "12x" or "-3" is ignored
    if (!/^\d+$/.test(pageInput.value.trim())) return;
    const n = parseInt(pageInput.value, 10);
    if (n < 1) return;
    const i = book.faceIndexByPage(Math.min(n, book.maxPage()));
    if (i < 0) return;
    this.jumpToFace(i);
  },
  async newEntry() {
    this.hide();
    if (book.open()) {
      while (book.busy) await new Promise((r) => setTimeout(r, 150));
    }
    editor.enter(null);
  },
};

tab.addEventListener("click", (e) => {
  e.stopPropagation();
  indexPanel.toggle();
});
closeBtn.addEventListener("click", () => indexPanel.hide());
goBtn.addEventListener("click", () => indexPanel.go());
newBtn.addEventListener("click", () => indexPanel.newEntry());
pageInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") indexPanel.go();
});

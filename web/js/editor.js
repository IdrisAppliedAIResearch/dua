// INVARIANT: entry text is the author's, verbatim. Nothing here may rewrite,
// correct, or reformat a saved entry's words — only the author's own edits change them.
import { state, sortEntries, findEntry } from "./state.js?v=20261118c";
import { api } from "./api.js?v=20261118c";
import { todayISO, parseDay, mediaSrc } from "./layout.js?v=20261118c";
import { book } from "./book.js?v=20261118c";

function svg(paths) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const ICONS = {
  check: svg('<path d="M4 12.5l5 5L20 6.5"/>'),
  cross: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  trash: svg('<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10.5 11v5.5M13.5 11v5.5"/>'),
};

let tempId = 1_000_000_000_000;

export const editor = {
  active: null,
  hooks: null,
  delTimer: null,
  mediaTimer: null,
  reflowTimer: null,
  suppressChar: false,

  init(hooks) {
    this.hooks = hooks;
    // typing that spills past the bottom of a page re-paginates the edited
    // entry live: the continuation appears on the next leaf and the book
    // follows the caret, so writing continues across pages without saving
    book.el.addEventListener("input", () => {
      if (this.active) this.scheduleReflow();
    });
    // The blank line between sections is the boundary between two separate
    // editable islands, so Backspace at a paragraph start and Delete at its
    // end hit an edge where the browser does nothing — the gap looks "hard
    // coded". Notes merges there: delete the gap, join the sections, leave
    // the caret at the seam.
    book.el.addEventListener("beforeinput", (ev) => {
      if (!this.active || !ev.inputType) return;
      const back = ev.inputType === "deleteContentBackward";
      const fwd = ev.inputType === "deleteContentForward";
      if (!back && !fwd) return;
      const sel = window.getSelection();
      if (!sel.rangeCount || !sel.isCollapsed || !sel.focusNode) return;
      const host = sel.focusNode.nodeType === 3 ? sel.focusNode.parentElement : sel.focusNode;
      const p = host && host.closest ? host.closest("p") : null;
      if (!p || !p.isContentEditable) return;
      const art = p.closest(".entry");
      if (!art || Number(art.dataset.id) !== this.active.id) return;
      const arts = [...book.el.querySelectorAll(`.entry[data-id="${this.active.id}"]`)];
      const paras = arts.flatMap((a) => [...a.querySelectorAll("p")]);
      const idx = paras.indexOf(p);
      if (idx < 0) return;
      const other = back ? paras[idx - 1] : paras[idx + 1];
      if (!other) return;
      if (!this.caretAtEdge(sel, p, back ? "start" : "end")) return;
      // The boundary here may not be the author's blank line at all but the
      // seam where the paginator broke one section across a page turn. There
      // is no gap to delete there — merging the halves would weld two words
      // together — so the key does nothing.
      const seam = back ? p : other;
      if (seam.dataset && seam.dataset.cont !== undefined) {
        ev.preventDefault();
        return;
      }
      // A picture is a block, not a paragraph to merge into: deleting the gap
      // beside it removes the picture itself, on the same two-step terms as
      // deleting an entry, so a stray Backspace can never eat an image.
      if (other.classList.contains("e-media")) {
        ev.preventDefault();
        this.deleteMedia(other, back);
        return;
      }
      ev.preventDefault();
      this.mergeSections(back ? other : p, back ? p : other);
    });
    // Clicking a picture is how you reach one that has no text beside it (a
    // run of them, laid out one after another): the block arms, and the next
    // delete key removes its line. The click is consumed here so it cannot
    // also turn the page.
    book.el.addEventListener(
      "click",
      (ev) => {
        if (!this.active) return;
        const t = ev.target && ev.target.closest ? ev.target : null;
        const media = t && t.closest ? t.closest(".e-media") : null;
        if (!media) {
          this.disarmMedia();
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        this.armMedia(media);
      },
      true
    );
    // A picture armed by that click takes the next delete key. This has to sit
    // on the document: clicking a picture leaves the caret outside every
    // editable host, and a delete key with no editable focus never produces a
    // beforeinput for the page to intercept. The caret path (a picture next to
    // text) is excluded below so the two never both act on one keypress.
    document.addEventListener("keydown", (ev) => {
      if (!this.active || (ev.key !== "Backspace" && ev.key !== "Delete")) return;
      const armed = book.el.querySelector(".e-media.armed");
      if (!armed || this.caretParagraph()) return;
      ev.preventDefault();
      this.commitMediaDelete(armed, ev.key === "Backspace");
    });
    // Enter is the author's blank line: it splits the section right at the
    // caret so a Notes-style gap opens there, and the caret moves to the new
    // line. Shift+Enter stays the literal hard break inside a section.
    book.el.addEventListener("keydown", (ev) => {
      if (!this.active || ev.key !== "Enter" || ev.shiftKey || ev.isComposing || ev.keyCode === 229) return;
      const p = this.caretParagraph();
      if (p) {
        ev.preventDefault();
        this.splitSection(p);
        return;
      }
      const t = ev.target && ev.target.closest ? ev.target : null;
      const head = t && t.closest ? t.closest(".e-title,.e-date") : null;
      if (head) {
        // Enter never writes a newline into the header: from the title it
        // moves the caret into the body, on the date it does nothing
        ev.preventDefault();
        if (head.classList.contains("e-title")) {
          const art = head.closest(".entry");
          const first = art && art.querySelector("p");
          if (first) this.setCaretIn(first, 0);
        }
      }
    });
    // iOS and some IMEs deliver Enter as a paragraph-insert input rather
    // than a handled keypress — same blank-line semantics
    book.el.addEventListener("beforeinput", (ev) => {
      if (!this.active || ev.inputType !== "insertParagraph") return;
      const p = this.caretParagraph();
      if (!p) return;
      ev.preventDefault();
      this.splitSection(p);
    });
  },

  // a collapsed caret sitting exactly at the first or last boundary of a
  // paragraph — measured in rendered characters, counting <br> as one, since
  // the paragraph may hold hard breaks (element/offset caret points inside a
  // text node are never Range-equal to the paragraph's own boundary)
  caretAtEdge(sel, p, edge) {
    const charLen = (n) => (n.nodeType === 3 ? n.length : n.nodeName === "BR" ? 1 : n.textContent.length);
    const node = sel.focusNode;
    let local = 0;
    if (node === p) {
      for (let i = 0; i < sel.focusOffset && i < p.childNodes.length; i++) {
        local += charLen(p.childNodes[i]);
      }
    } else {
      let found = false;
      const walk = (parent) => {
        for (const c of parent.childNodes) {
          if (found) return;
          if (c === node) {
            local += node.nodeType === 3 ? sel.focusOffset : 0;
            found = true;
            return;
          }
          if (c.nodeType === 3 || c.nodeName === "BR") local += charLen(c);
          else walk(c);
        }
      };
      walk(p);
      if (!found) return false;
    }
    let total = 0;
    p.childNodes.forEach((c) => { total += charLen(c); });
    return edge === "start" ? local === 0 : local >= total;
  },

  // join curP directly onto prevP's end — the Notes behavior for deleting a
  // section gap — then repaginate and put the caret at the seam
  mergeSections(prevP, curP) {
    const entry = findEntry(this.active.id);
    if (!entry) return;
    const seam = document.createRange();
    seam.selectNodeContents(prevP);
    seam.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(seam);
    const caret = this.caretOffset();
    const frag = document.createDocumentFragment();
    while (curP.firstChild) frag.appendChild(curP.firstChild);
    prevP.append(frag);
    curP.remove();
    Object.assign(entry, this.collect());
    this.unmarkDom();
    this.hooks.rerender();
    this.mark();
    if (caret !== null) this.followCaret(caret);
  },

  // Removing a picture is a two-step on the same terms as deleting an entry:
  // the first press marks the block that is about to go, the second lets it
  // go, and either way the body loses exactly its own file line.
  deleteMedia(mediaEl, back) {
    if (!mediaEl.classList.contains("armed")) {
      this.armMedia(mediaEl);
      return;
    }
    this.commitMediaDelete(mediaEl, back);
  },

  armMedia(mediaEl) {
    this.disarmMedia();
    mediaEl.classList.add("armed");
    clearTimeout(this.mediaTimer);
    this.mediaTimer = setTimeout(() => this.disarmMedia(), 4000);
  },

  disarmMedia() {
    clearTimeout(this.mediaTimer);
    for (const el of book.el.querySelectorAll(".e-media.armed")) el.classList.remove("armed");
  },

  commitMediaDelete(mediaEl, back) {
    clearTimeout(this.mediaTimer);
    const entry = findEntry(this.active.id);
    if (!entry) return;
    const caret = this.caretOffset();
    const arts = [...book.el.querySelectorAll(`.entry[data-id="${this.active.id}"]`)];
    const paras = arts.flatMap((a) => [...a.querySelectorAll("p")]);
    const at = paras.indexOf(mediaEl);
    // removing the block removes its text and the separator that joined it
    const shift =
      this.paraText(mediaEl).length +
      (at + 1 < paras.length ? this.sepBefore(paras[at + 1]).length : this.sepBefore(mediaEl).length);
    mediaEl.remove();
    Object.assign(entry, this.collect());
    this.unmarkDom();
    this.hooks.rerender();
    this.mark();
    if (caret !== null) this.followCaret(back ? Math.max(0, caret - shift) : caret);
  },

  // the editable paragraph currently holding the caret, if it belongs to the
  // entry being edited
  caretParagraph() {
    if (!this.active) return null;
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.focusNode) return null;
    const node = sel.focusNode;
    const host = node.nodeType === 3 ? node.parentElement : node;
    const p = host && host.closest ? host.closest("p") : null;
    if (!p || !p.isContentEditable) return null;
    const art = p.closest(".entry");
    if (!art || Number(art.dataset.id) !== this.active.id) return null;
    return p;
  },

  // the Notes blank line: one Enter breaks the section in two right where the
  // caret sits — the gap appears live — then the entry repaginates and the
  // caret continues at the top of the lower half
  splitSection(p) {
    const entry = findEntry(this.active.id);
    const sel = window.getSelection();
    if (!entry || !sel.rangeCount) return;
    const arts = [...book.el.querySelectorAll(`.entry[data-id="${this.active.id}"]`)];
    const idx = arts.flatMap((a) => [...a.querySelectorAll("p")]).indexOf(p);
    if (idx < 0) return;
    const caret = sel.getRangeAt(0).cloneRange();
    const tail = document.createRange();
    tail.selectNodeContents(p);
    try {
      tail.setStart(caret.startContainer, caret.startOffset);
    } catch (_) {
      return;
    }
    const np = document.createElement("p");
    np.append(tail.extractContents());
    p.after(np);
    Object.assign(entry, this.collect());
    this.unmarkDom();
    this.hooks.rerender();
    this.mark();
    const paras = [...book.el.querySelectorAll(`.entry[data-id="${this.active.id}"]`)].flatMap((a) => [
      ...a.querySelectorAll("p"),
    ]);
    const target = paras[idx + 1] || paras[idx];
    if (!target) return;
    this.revealFace(target);
    this.setCaretIn(target, 0);
  },

  // bring the spread that shows el into view (single-page mode: a jump)
  revealFace(el) {
    const face = el.closest(".face");
    if (!face) return;
    const leafIdx = book.leaves.findIndex((l) => l.front === face || l.back === face);
    if (leafIdx < 0) return;
    const faceIdx = 2 * leafIdx + (book.leaves[leafIdx].front === face ? 0 : 1);
    const s = state.spread;
    if (faceIdx !== 2 * s - 1 && faceIdx !== 2 * s) book.gotoInstant(Math.ceil(faceIdx / 2));
  },

  scheduleReflow() {
    clearTimeout(this.reflowTimer);
    this.reflowTimer = setTimeout(() => this.reflow(), 350);
  },

  reflow() {
    if (!this.active || state.editing === null) return;
    const id = this.active.id;
    const arts = [...book.el.querySelectorAll(`.entry[data-id="${id}"]`)];
    if (!arts.length) return;
    const overflowing = arts.some((a) => {
      const wrap = a.closest(".page-body");
      return wrap && wrap.scrollHeight - wrap.clientHeight > 1;
    });
    // a section that has just become (or stopped being) a picture changes the
    // page breaks without overflowing, so it needs its own relayout trigger:
    // typing media/foo.jpg turns into the picture itself
    const changedMedia = arts.some((a) =>
      [...a.querySelectorAll("p")].some(
        (p) => !!mediaSrc(this.paraText(p)) !== p.classList.contains("e-media"),
      ),
    );
    if (!overflowing && !changedMedia) return;
    if (book.busy) {
      this.scheduleReflow();
      return;
    }
    const caret = this.caretOffset();
    const entry = findEntry(id);
    if (!entry) return;
    Object.assign(entry, this.collect());
    this.unmarkDom();
    this.hooks.rerender();
    this.mark();
    if (caret !== null) this.followCaret(caret);
  },

  // global character offset (paragraphs joined with blank lines, exactly as
  // collect() joins them) of the current caret, within the edited entry
  caretOffset() {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.focusNode) return null;
    const node = sel.focusNode;
    const host = node.nodeType === 3 ? node.parentElement : node;
    const p = host && host.closest ? host.closest("p") : null;
    if (!p) return null;
    const arts = [...book.el.querySelectorAll(`.entry[data-id="${this.active.id}"]`)];
    const paras = arts.flatMap((a) => [...a.querySelectorAll("p")]);
    const idx = paras.indexOf(p);
    if (idx < 0) return null;
    let acc = 0;
    for (let i = 0; i < idx; i++) acc += this.paraText(paras[i]).length + this.sepBefore(paras[i + 1] || p).length;
    let local = 0;
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n === node) {
        local += sel.focusOffset;
        break;
      }
      local += n.length;
    }
    return acc + Math.min(local, this.paraText(p).length);
  },

  // Sections holding a picture carry no caret: a page break that lands there
  // parks the caret at the start of the next real paragraph.
  followCaret(globalOffset) {
    const arts = [...book.el.querySelectorAll(`.entry[data-id="${this.active.id}"]`)];
    const paras = arts.flatMap((a) => [...a.querySelectorAll("p")]);
    if (!paras.length) return;
    let acc = 0;
    let target = null;
    let local = 0;
    for (let i = 0; i < paras.length; i++) {
      const p = paras[i];
      acc += i === 0 ? 0 : this.sepBefore(p).length;
      const len = this.paraText(p).length;
      if (globalOffset <= acc + len) {
        target = p;
        local = globalOffset - acc;
        break;
      }
      acc += len;
    }
    if (!target || target.classList.contains("e-media")) {
      // continue in the nearest section made of words: the one right after
      // the picture, else the one before it
      const i = target ? paras.indexOf(target) : paras.length - 1;
      const next = paras.slice(i + 1).find((p) => !p.classList.contains("e-media"));
      if (next) {
        target = next;
        local = 0;
      } else {
        const prev = paras.slice(0, i).reverse().find((p) => !p.classList.contains("e-media"));
        if (!prev) return;
        target = prev;
        local = this.paraText(prev).length;
      }
    }
    this.revealFace(target);
    this.setCaretIn(target, Math.min(local, this.paraText(target).length));
  },

  setCaretIn(p, target) {
    p.focus();
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let n;
    let acc = 0;
    while ((n = walker.nextNode())) {
      if (acc + n.length >= target) {
        const range = document.createRange();
        range.setStart(n, Math.min(target - acc, n.length));
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      acc += n.length;
    }
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  },

  async enter(id) {
    if (this.active && state.editing === null) this.finish(); // heal inconsistent state
    if (this.active || book.busy) return;
    let entry;
    if (id === null) {
      entry = { id: ++tempId, date: todayISO(), title: "", body: "", draft: true, created_at: null, updated_at: null };
      state.entries.push(entry);
      sortEntries();
      this.active = { id: entry.id, snap: null };
      this.hooks.rerender();
      await book.gotoEntry(entry.id);
    } else {
      // edit where the author already is: never jump back to the entry's
      // first page — the pencil only exists on faces already on screen
      entry = findEntry(id);
      if (!entry) return;
      this.active = { id, snap: JSON.parse(JSON.stringify(entry)) };
    }
    state.editing = this.active.id;
    document.body.classList.add("mode-edit");
    this.mark();
  },

  mark() {
    const id = this.active.id;
    this.unmarkDom();
    let facesDone = new Set();
    book.el.querySelectorAll(`.entry[data-id="${id}"]`).forEach((art) => {
      art.classList.add("editing");
      if (!art.querySelector("p") && this.active.snap === null) {
        const p = document.createElement("p");
        p.textContent = "";
        art.append(p); // an empty draft still needs one editable paragraph
      }
      art.querySelectorAll(".e-date,.e-title,p").forEach((el2) => {
        // a picture is a block, not text: the caret never goes inside one
        if (el2.classList.contains("e-media")) return;
        el2.setAttribute("contenteditable", "plaintext-only");
      });
      const face = art.closest(".face");
      if (face && !facesDone.has(face)) {
        facesDone.add(face);
        face.classList.add("editing-page");
        this.rail(face);
      }
    });
    const first = this.focusSpread();
    if (first && this.suppressChar) {
      // the same keystroke that opened the editor must not type into it
      this.suppressChar = false;
      const guard = (ev) => {
        if (ev.inputType === "insertText" && (ev.data || "").length === 1) {
          ev.preventDefault();
        }
      };
      first.addEventListener("beforeinput", guard);
      setTimeout(() => first.removeEventListener("beforeinput", guard), 400);
    } else if (this.suppressChar) {
      this.suppressChar = false;
    }
  },

  // caret goes to the entry page actually on screen (end of its last
  // paragraph: the natural continuation point), not the entry's first page
  focusSpread() {
    if (!this.active) return null;
    const arts = [...book.el.querySelectorAll(`.entry[data-id="${this.active.id}"]`)];
    if (!arts.length) return null;
    const visible = arts.filter((a) => {
      const f = a.closest(".face");
      return f && (f.classList.contains("cur-left") || f.classList.contains("cur-right"));
    });
    const art =
      visible.find((a) => a.querySelector("p:not(.e-media)")) ||
      visible[0] ||
      arts.find((a) => a.querySelector("p:not(.e-media)")) ||
      arts[0];
    const paras = art ? [...art.querySelectorAll("p")].filter((p) => !p.classList.contains("e-media")) : [];
    const p = paras[paras.length - 1];
    if (!p) return null;
    p.focus();
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return p;
  },

  rail(face) {
    const rail = document.createElement("div");
    rail.className = "icon-rail " + (face.classList.contains("recto") ? "right" : "left");
    rail.dataset.id = this.active.id;
    rail.innerHTML =
      `<button data-act="save" aria-label="save">${ICONS.check}</button>` +
      `<button data-act="cancel" aria-label="cancel">${ICONS.cross}</button>` +
      `<button data-act="delete" aria-label="delete">${ICONS.trash}</button>`;
    face.append(rail);
    requestAnimationFrame(() => rail.classList.add("shown"));
  },

  unmarkDom() {
    book.el.querySelectorAll(".face.editing-page").forEach((f) => {
      f.classList.remove("editing-page");
      f.querySelectorAll(".icon-rail").forEach((r) => r.remove());
    });
    book.el.querySelectorAll(".entry.editing").forEach((art) => {
      art.classList.remove("editing");
      art.querySelectorAll("[contenteditable]").forEach((el2) => el2.removeAttribute("contenteditable"));
    });
  },

  finish() {
    clearTimeout(this.delTimer);
    clearTimeout(this.reflowTimer);
    this.disarmMedia();
    this.unmarkDom();
    document.body.classList.remove("mode-edit");
    state.editing = null;
    this.active = null;
  },

  // what stands between two rendered paragraphs in the stored text: the
  // author's blank line, or the seam the paginator made when it broke one
  // section across a page turn (carried on the tail paragraph as data-cont)
  sepBefore(el) {
    const c = el.dataset ? el.dataset.cont : undefined;
    return c === "\n" ? "\n" : c === " " ? " " : "\n\n";
  },

  // The text a paragraph element stands for in the saved body: a picture
  // stands for its own file line, everything else for its own nodes. This
  // deliberately does NOT use innerText: innerText is computed from rendering,
  // and every page except the one on screen is display:none — where it quietly
  // drops each <br>, so saving an entry would delete the author's hard breaks
  // on the pages they were not standing on. Whitespace is collapsed the way
  // splitParas() collapses it, so the DOM and the saved text agree.
  paraText(el) {
    if (el.classList.contains("e-media")) return el.dataset.src || "";
    let out = "";
    const walk = (parent) => {
      for (const c of parent.childNodes) {
        if (c.nodeType === 3) out += c.data;
        else if (c.nodeName === "BR") out += "\n";
        else if (c.nodeName === "DIV" || c.nodeName === "P") {
          if (out && !out.endsWith("\n")) out += "\n";
          walk(c);
        } else walk(c);
      }
    };
    walk(el);
    return out
      .replace(/\u00a0/g, " ")
      .replace(/\u200b/g, "")
      .replace(/[ \t]+/g, " ")
      .trim();
  },

  collect() {
    const id = this.active.id;
    const arts = [...book.el.querySelectorAll(`.entry[data-id="${id}"]`)];
    const dateText = arts[0] && arts[0].querySelector('[data-role="date"]')
      ? arts[0].querySelector('[data-role="date"]').innerText
      : null;
    const title = arts[0] && arts[0].querySelector('[data-role="title"]')
      ? arts[0].querySelector('[data-role="title"]').innerText.trim()
      : "";
    // blank paragraphs survive: an empty line between two paragraphs is an
    // author's double Enter and stays one; the very ends are trimmed on save.
    // A tail paragraph (data-cont) grows the section it belongs to, so a page
    // seam is never written back as a paragraph break.
    const parts = [];
    for (const p of arts.flatMap((a) => [...a.querySelectorAll("p")])) {
      const t = this.paraText(p);
      if (!parts.length) parts.push(t);
      else parts[parts.length - 1] += this.sepBefore(p) + t;
    }
    const body = parts.join("\n\n");
    const entry = findEntry(id);
    const date = dateText ? parseDay(dateText, entry.date) : entry.date;
    return { date, title, body };
  },

  async save() {
    if (!this.active) return;
    const id = this.active.id;
    const entry = findEntry(id);
    const { date, title, body: raw } = this.collect();
    const body = raw.trim();
    if (!body) return;
    try {
      if (entry.draft) {
        const created = await api.create({ date, title, body });
        state.entries.splice(state.entries.indexOf(entry), 1, created);
        this.active.id = created.id;
      } else {
        const updated = await api.update(id, { date, title, body });
        Object.assign(entry, updated);
      }
      sortEntries();
      this.hooks.setOffline(false);
      this.finish();
      this.hooks.rerender();
    } catch (err) {
      // the blot means unreachable: an HTTP error (4xx/5xx) still has a
      // reachable server, so do not mislabel a validation failure as offline
      this.hooks.setOffline(!err || err.status == null);
    }
  },

  cancel() {
    if (!this.active) {
      // wedged edit state (active lost but editing set): clear the UI
      this.finish();
      this.hooks.rerender();
      return;
    }
    const entry = findEntry(this.active.id);
    if (entry && entry.draft) {
      state.entries.splice(state.entries.indexOf(entry), 1);
    } else if (entry) {
      Object.assign(entry, this.active.snap);
    }
    this.finish();
    this.hooks.rerender();
  },

  del(btn) {
    if (!this.active) return;
    if (!btn.classList.contains("armed")) {
      btn.classList.add("armed");
      clearTimeout(this.delTimer);
      this.delTimer = setTimeout(() => btn.classList.remove("armed"), 4000);
      return;
    }
    clearTimeout(this.delTimer);
    const id = this.active.id;
    const entry = findEntry(id);
    this.finish();
    const commit = async () => {
      if (!entry.draft) {
        try {
          await api.remove(id);
          this.hooks.setOffline(false);
        } catch (err) {
          // the server still has the entry; removing it locally anyway would
          // only make it reappear on the next reload — keep it visible
          this.hooks.setOffline(!err || err.status == null);
          return;
        }
      }
      const i = state.entries.indexOf(entry);
      if (i >= 0) state.entries.splice(i, 1);
      this.hooks.rerender();
      if (state.spread > book.max) book.gotoInstant(book.max);
    };
    commit();
  },

  railAction(btn) {
    const act = btn.dataset.act;
    if (act === "save") this.save();
    else if (act === "cancel") this.cancel();
    else if (act === "delete") this.del(btn);
  },
};

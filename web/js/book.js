import { state } from "./state.js?v=20261112c";
import { PAD, formatDay } from "./layout.js?v=20261112c";

const TURN_MS = 780;

function svg(paths) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const PENCIL = svg('<path d="M4 20l1.2-4.2L16.7 4.3a2.2 2.2 0 0 1 3.1 3.1L8.3 18.9 4 20z"/>');
const PLUS = svg('<path d="M12 6v12M6 12h12"/>');

export const book = {
  el: document.getElementById("book"),
  leaves: [],
  faces: [],
  L: 0,
  max: 0,
  single: false,
  busyUntil: 0,

  // time-based so a Safari timer paused by backgrounding can never wedge the
  // book in a "busy" state forever
  get busy() {
    return Date.now() < this.busyUntil;
  },

  recover() {
    this.busyUntil = 0;
    this.el.querySelectorAll(".leaf.animating").forEach((l) => l.classList.remove("animating"));
  },

  geom() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // one page at a time on every screen (user request 2026-11-11): the book
    // is read on the phone, and a two-page spread squeezes two columns of
    // text into a phone width. If spread mode is ever wanted again, this flag
    // and the one-page CSS block in dua.css must flip together.
    const single = true;
    let pageW;
    if (single) pageW = Math.min(vw * 0.9, (vh * 0.84) / 1.45);
    else pageW = Math.min(vw * 0.44, (vh * 0.86) / 1.45);
    pageW = Math.round(Math.max(pageW, 240));
    const pageH = Math.round(pageW * 1.45);
    const root = document.documentElement.style;
    root.setProperty("--page-w", pageW + "px");
    root.setProperty("--page-h", pageH + "px");
    return {
      pageW,
      pageH,
      colW: Math.round(pageW * (1 - PAD.inner - PAD.outer)),
      colH: Math.round(pageH * (1 - PAD.top - PAD.bottom)),
      single,
    };
  },

  build(pages, geom) {
    this.single = geom.single;
    if (!pages.length) pages = [{ invitation: true, paras: [] }];

    const faces = [{ kind: "cover" }];
    let num = 0;
    if (geom.single) {
      // one page per leaf-front: each turn advances exactly one page number;
      // leaf backs are blank pads (the phone viewport only ever shows fronts)
      faces.push({ kind: "pad" });
      // invitation faces carry no folio number, same as in spread mode
      for (const p of pages)
        faces.push({ kind: "page", page: p, num: p.invitation ? null : ++num }, { kind: "pad" });
      this.max = faces.length / 2 - 1;
    } else {
      faces.push({ kind: "endpaper" });
      for (const p of pages) faces.push({ kind: "page", page: p, num: p.invitation ? null : ++num });
      if (faces.length % 2) faces.push({ kind: "pad" });
      this.max = faces.length / 2;
    }
    this.faces = faces;

    this.el.querySelectorAll(".leaf").forEach((l) => l.remove());
    this.leaves = [];
    const L = faces.length / 2;
    for (let j = 0; j < L; j++) {
      const leaf = document.createElement("div");
      leaf.className = "leaf";
      const front = this.faceEl(faces[2 * j], "front");
      const back = this.faceEl(faces[2 * j + 1], "back");
      leaf.append(front, back);
      this.el.append(leaf);
      this.leaves.push({ el: leaf, front, back });
    }
    this.L = L;
    if (geom.single) this.max = L - 1;
    if (state.spread > this.max) state.spread = this.max;
    this.setSpread(state.spread);
  },

  faceEl(face, side) {
    const el = document.createElement("div");
    el.className = `face grain-face ${side === "front" ? "recto" : "verso back"}`;
    el.dataset.side = side;

    if (face.kind === "cover") {
      el.classList.add("cover");
      el.innerHTML =
        '<div class="frame-outer"></div>' +
        '<div class="frame-inner"></div>' +
        '<div class="cover-title">DUA</div>' +
        '<div class="cover-sub">دعاء</div>' +
        '<div class="cover-ornament"></div>';
      return el;
    }
    if (face.kind === "endpaper") {
      el.classList.add("endpaper");
      el.innerHTML = '<div class="end-flourish"></div>';
      return el;
    }
    if (face.kind === "pad") return el;

    const curl = document.createElement("div");
    curl.className = "curl";
    el.append(curl);
    const p = face.page;
    el.classList.add("page");
    if (p.invitation) {
      const inv = document.createElement("div");
      inv.className = "invitation";
      inv.dataset.invite = "1";
      inv.innerHTML = PLUS;
      el.append(inv);
      return el;
    }
    // pencil lives on the face, not inside .page-body (which clips overflow)
    const pen = document.createElement("button");
    pen.className = "pencil";
    pen.dataset.id = p.entryId;
    pen.setAttribute("aria-label", "edit");
    pen.innerHTML = PENCIL;
    el.append(pen);
    const body = document.createElement("div");
    body.className = "page-body";
    const art = document.createElement("article");
    art.className = "entry";
    art.dataset.id = p.entryId;
    if (p.header) {
      if (p.entry.date) {
        const d = document.createElement("h2");
        d.className = "e-date";
        d.dataset.role = "date";
        d.textContent = formatDay(p.entry.date);
        art.append(d);
      }
      if (p.entry.title) {
        const t = document.createElement("h3");
        t.className = "e-title";
        t.dataset.role = "title";
        t.textContent = p.entry.title;
        art.append(t);
      }
    }
    for (const para of p.paras) {
      const el2 = document.createElement("p");
      para.split("\n").forEach((line, i) => {
        if (i) el2.append(document.createElement("br")); // author's hard break
        el2.append(document.createTextNode(line));
      });
      art.append(el2);
    }
    body.append(art);
    el.append(body);
    if (face.num != null) {
      const f = document.createElement("span");
      f.className = "folio";
      f.textContent = face.num;
      el.append(f);
    }
    return el;
  },

  setSpread(s) {
    state.spread = s;
    const L = this.L;
    for (let j = 0; j < L; j++) {
      const flipped = j < s;
      const el = this.leaves[j].el;
      el.classList.toggle("flipped", flipped);
      // iOS jetsam-kills Safari when many 3D-transformed layers exist offscreen
      // (WebKit bug 279637). Only the current left/right leaves are renderable.
      el.classList.toggle("dormant", j < s - 1 || j > s);
      el.style.zIndex = flipped ? j + 1 : 2 * L - j;
    }
    this.el.classList.toggle("closed", s === 0);
    this.el.querySelectorAll(".cur-left,.cur-right").forEach((el) =>
      el.classList.remove("cur-left", "cur-right")
    );
    if (s >= 1) this.leaves[s - 1].back.classList.add("cur-left");
    if (s < L) this.leaves[s].front.classList.add("cur-right");
  },

  turn(dir) {
    if (this.busy) return false;
    const s = state.spread;
    if (dir > 0 && s >= this.max) return false;
    if (dir < 0 && s <= 0) return false;
    this.el.querySelectorAll(".leaf.animating").forEach((l) => l.classList.remove("animating"));
    const leaf = (dir > 0 ? this.leaves[s] : this.leaves[s - 1]).el;
    this.busyUntil = Date.now() + TURN_MS;
    leaf.classList.add("animating");
    this.setSpread(s + dir);
    setTimeout(() => {
      if (!this.busy) leaf.classList.remove("animating");
    }, TURN_MS);
    return true;
  },

  open() {
    return state.spread === 0 ? this.turn(1) : false;
  },

  close() {
    if (state.spread === 0) return false;
    if (state.spread === 1) return this.turn(-1);
    this.gotoInstant(0);
    return true;
  },

  gotoInstant(s) {
    s = Math.max(0, Math.min(this.max, s));
    this.el.classList.add("instant");
    this.setSpread(s);
    void this.el.offsetWidth;
    this.el.classList.remove("instant");
  },

  faceIndexWithEntry(id) {
    for (let i = 0; i < this.faces.length; i++) {
      const f = this.faces[i];
      if (f.kind === "page" && f.page.entryId === id) return i;
    }
    return -1;
  },

  faceIndexByPage(num) {
    for (let i = 0; i < this.faces.length; i++) {
      const f = this.faces[i];
      if (f.kind === "page" && f.num === num) return i;
    }
    return -1;
  },

  maxPage() {
    let m = 0;
    for (const f of this.faces) if (f.kind === "page" && f.num > m) m = f.num;
    return m;
  },

  gotoEntry(id) {
    const i = this.faceIndexWithEntry(id);
    if (i < 0) return;
    const s = Math.ceil(i / 2);
    const delta = s - state.spread;
    if (delta === 0) return;
    if (Math.abs(delta) === 1 && !this.busy) this.turn(delta);
    else this.gotoInstant(s);
  },

  entriesOnSpread() {
    const s = state.spread;
    const ids = [];
    for (const i of [2 * s - 1, 2 * s]) {
      const f = this.faces[i];
      if (f && f.kind === "page" && f.page.entryId != null) ids.push(f.page.entryId);
    }
    return ids;
  },
};

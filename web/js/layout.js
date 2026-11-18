export const PAD = { inner: 0.13, outer: 0.115, top: 0.115, bottom: 0.145 };

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const measureEl = document.getElementById("measure");

export function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function parseDay(text, fallback) {
  const t = (text || "").trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  }
  m = t.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/);
  if (m) {
    const mi = MONTHS.findIndex((x) => x.toLowerCase().startsWith(m[2].toLowerCase()));
    if (mi >= 0) {
      return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
    }
  }
  return fallback;
}

// A blank line separates paragraphs; a single newline inside one is a hard
// line break the author wrote, and it survives as such. An empty section
// between two filled ones is an intentional blank line (the author's double
// Enter): it renders as a zero-height paragraph, so the gap around it reads
// as one extra empty line. Ends are trimmed when the entry is saved.
export function splitParas(body) {
  return (body || "")
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t\u00a0]*\n/)
    .map((p) =>
      p
        .split(/\n+/)
        .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
        .filter((line) => line.length > 0)
        .join("\n"),
    );
}

// An embedded picture is a section whose entire text is a media file path:
//   media/01-IMG_1578.jpg
// Plain text stays the only storage format. The line is a real relative path
// to a file kept beside the database, so the book stays readable forever and
// a missing file degrades to the line of text rather than a broken-image hole.
const MEDIA_RE = /^media\/[A-Za-z0-9][A-Za-z0-9 ._[\]-]*\.(?:jpe?g|png|webp|gif)$/i;

export function mediaSrc(section) {
  const t = (section || "").trim();
  return MEDIA_RE.test(t) ? t : null;
}

// Pagination needs a block's height before the browser has decoded the file,
// so every rendered aspect ratio is remembered here. A ratio that arrives
// late (first paint, cold cache) bumps the layout epoch and asks for one
// debounced re-pagination; after that the page breaks are stable.
const aspects = new Map();
let aspectEpoch = 0;
let aspectsChanged = null;
let aspectsTimer = null;

export function onMediaAspects(fn) {
  aspectsChanged = fn;
}

export function mediaAspect(src) {
  return aspects.get(src) || 0;
}

export function noteMediaAspect(src, w, h) {
  if (!w || !h) return;
  const r = w / h;
  const old = aspects.get(src);
  if (old && Math.abs(old - r) < 0.01) return;
  aspects.set(src, r);
  aspectEpoch++;
  clearTimeout(aspectsTimer);
  aspectsTimer = setTimeout(() => {
    if (aspectsChanged) aspectsChanged();
  }, 150);
}

const esc = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function setMeasure(html) {
  measureEl.innerHTML = html;
  return measureEl;
}

// A page's height is the sum of its block boxes plus their margins: the
// Notes-style inter-section gap is a margin-top on every paragraph that
// follows another (p + p), so it is counted between sections here — and in a
// fresh page the candidate is the first child, has no margin-top, and the gap
// correctly drops at the break, exactly as it renders.
function blockHeight(html) {
  setMeasure(html);
  let h = 0;
  for (const ch of measureEl.children) {
    const cs = getComputedStyle(ch);
    h +=
      ch.getBoundingClientRect().height +
      parseFloat(cs.marginTop) +
      parseFloat(cs.marginBottom);
  }
  return h;
}

// The measure copy of a picture must be typographically identical to the one
// book.js puts on the page, or the paginator mis-measures the block.
function mediaHtml(src) {
  const r = mediaAspect(src);
  const style = r ? ` style="aspect-ratio:${r.toFixed(4)}"` : "";
  return `<p class="e-media" data-src="${esc(src)}"><img src="${esc(src)}" alt=""${style}></p>`;
}

function parasHtml(strings) {
  return strings
    .map((s) => {
      const src = mediaSrc(s);
      return src ? mediaHtml(src) : `<p>${esc(s).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function headerHtml(entry) {
  let h = "";
  if (entry.date) h += `<h2 class="e-date">${esc(formatDay(entry.date))}</h2>`;
  if (entry.title) h += `<h3 class="e-title">${esc(entry.title)}</h3>`;
  return h;
}

// Re-paginating all entries costs hundreds of forced layouts (~1s on a phone).
// A page break for an entry only changes when its content or the column size
// changes, so results are memoized per column size. A hit is validated against
// the exact text it was computed from (body+date+title): an edit that happens
// to preserve the entry's length and timestamp still relayouts correctly, and
// drafts (which have no updated_at at all) can never serve a stale page.
const caches = new Map(); // "colW x colH" -> Map(entryId -> { src, pages })

function layoutSignature(entry) {
  return `${entry.body}\u0000${entry.date || ""}\u0000${entry.title || ""}`;
}

function layoutEntry(entry, colH) {
  const pages = [];
  const paras = splitParas(entry.body);
  if (paras.length === 0) {
    pages.push({ entryId: entry.id, entry, paras: [], header: true });
    return pages;
  }
  const headerH = blockHeight(headerHtml(entry));
  let cur = [];
  let avail = colH - headerH;
  // cont records, for a page's FIRST paragraph, that it is not a new section
  // but the continuation of the last paragraph of the previous page: " " when
  // a prose paragraph was broken between words, "\n" when a stanza was broken
  // between lines, "" when the page really starts a new section. Without it
  // the editor could not tell a page seam from an author's blank line, and
  // saving an entry would write the seam into the text as a new paragraph.
  let cont = "";
  let page = { entryId: entry.id, entry, paras: cur, header: true, cont: "" };
  pages.push(page);

  const newPage = (carry = "") => {
    cur = [];
    cont = carry;
    page = { entryId: entry.id, entry, paras: cur, header: false, cont };
    pages.push(page);
    avail = colH;
  };

  // prose: fill the current page with as many words as fit, continue after
  const fillProse = (para) => {
    let words = para.split(" ");
    let placed = false; // has any of this section gone on a page yet?
    while (words.length) {
      if (blockHeight(parasHtml(cur.concat([words.join(" ")]))) <= avail) {
        cur.push(words.join(" "));
        break;
      }
      let lo = 0;
      let hi = words.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (blockHeight(parasHtml(cur.concat([words.slice(0, mid).join(" ")]))) <= avail) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      if (lo === 0 && cur.length === 0) lo = 1;
      if (lo > 0) {
        cur.push(words.slice(0, lo).join(" "));
        placed = true;
      }
      words = words.slice(lo);
      if (!words.length) break;
      // the next page starts with the rest of this section only if part of it
      // is already behind us; a section that merely did not fit starts fresh
      newPage(placed ? " " : "");
    }
  };

  // hard-broken paragraph: page-breaks land only between whole lines, so a
  // stanza never splits mid-line and jumps to the next page intact unless its
  // own first line is too tall even for a fresh column
  const fillStanza = (para) => {
    let lines = para.split("\n");
    let placed = false; // has any of this stanza gone on a page yet?
    while (lines.length) {
      if (blockHeight(parasHtml(cur.concat([lines.join("\n")]))) <= avail) {
        cur.push(lines.join("\n"));
        return;
      }
      let lo = 0;
      let hi = lines.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (blockHeight(parasHtml(cur.concat([lines.slice(0, mid).join("\n")]))) <= avail) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      if (lo === 0) {
        if (cur.length > 0) {
          newPage(placed ? "\n" : "");
          continue;
        }
        // fresh page and the first line alone overflows the column:
        // word-fill so pagination always makes progress
        const words = lines[0].split(" ");
        let wlo = 0;
        let whi = words.length;
        while (wlo < whi) {
          const mid = (wlo + whi + 1) >> 1;
          if (blockHeight(parasHtml([words.slice(0, mid).join(" ")])) <= avail) {
            wlo = mid;
          } else {
            whi = mid - 1;
          }
        }
        if (wlo === 0) wlo = 1;
        cur.push(words.slice(0, wlo).join(" "));
        placed = true;
        const left = words.slice(wlo).join(" ");
        lines = left ? [left].concat(lines.slice(1)) : lines.slice(1);
        // the break fell inside one line: the seam was a space, not a hard break
        newPage(" ");
        continue;
      }
      cur.push(lines.slice(0, lo).join("\n"));
      placed = true;
      lines = lines.slice(lo);
      if (lines.length) newPage("\n");
    }
  };

  // a picture is one atomic block: it never splits and never shares a page
  // with a block that would overflow. One taller than the column is clamped by
  // CSS on its own page, so pagination always makes progress.
  const fillImage = (para) => {
    if (blockHeight(parasHtml(cur.concat([para]))) <= avail) {
      cur.push(para);
      return;
    }
    if (cur.length) newPage();
    cur.push(para);
  };

  for (const para of paras) {
    if (mediaSrc(para)) fillImage(para);
    else if (para.includes("\n")) fillStanza(para);
    else fillProse(para);
  }
  return pages;
}

export function computePages(entries, colH, colW) {
  // aspectEpoch is part of the key because a picture measured with an assumed
  // ratio must never keep its pages after the real ratio arrives
  const geomKey = `${colW}x${colH}x${aspectEpoch}`;
  let cache = caches.get(geomKey);
  if (!cache) {
    caches.clear(); // only the current column size is ever laid out again
    cache = new Map();
    caches.set(geomKey, cache);
  }
  const pages = [];
  const liveIds = new Set();
  for (const entry of entries) {
    liveIds.add(entry.id);
    const src = layoutSignature(entry);
    const hit = cache.get(entry.id);
    let pp = hit && hit.src === src ? hit.pages : null;
    if (!pp) {
      pp = layoutEntry(entry, colH);
      cache.set(entry.id, { src, pages: pp });
    }
    for (const pg of pp) pages.push(pg);
  }
  // drop ids that are gone (deleted entries, discarded drafts) so the cache
  // can never grow without bound
  if (cache.size > entries.length) {
    for (const id of cache.keys()) if (!liveIds.has(id)) cache.delete(id);
  }
  return pages;
}

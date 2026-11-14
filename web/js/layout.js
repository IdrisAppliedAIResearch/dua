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

function parasHtml(strings) {
  return strings.map((s) => `<p>${esc(s).replace(/\n/g, "<br>")}</p>`).join("");
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
  let page = { entryId: entry.id, entry, paras: cur, header: true };
  pages.push(page);

  const newPage = () => {
    cur = [];
    page = { entryId: entry.id, entry, paras: cur, header: false };
    pages.push(page);
    avail = colH;
  };

  // prose: fill the current page with as many words as fit, continue after
  const fillProse = (para) => {
    let words = para.split(" ");
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
      if (lo > 0) cur.push(words.slice(0, lo).join(" "));
      words = words.slice(lo);
      if (!words.length) break;
      newPage();
    }
  };

  // hard-broken paragraph: page-breaks land only between whole lines, so a
  // stanza never splits mid-line and jumps to the next page intact unless its
  // own first line is too tall even for a fresh column
  const fillStanza = (para) => {
    let lines = para.split("\n");
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
          newPage();
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
        const left = words.slice(wlo).join(" ");
        lines = left ? [left].concat(lines.slice(1)) : lines.slice(1);
        newPage();
        continue;
      }
      cur.push(lines.slice(0, lo).join("\n"));
      lines = lines.slice(lo);
      if (lines.length) newPage();
    }
  };

  for (const para of paras) {
    if (para.includes("\n")) fillStanza(para);
    else fillProse(para);
  }
  return pages;
}

export function computePages(entries, colH, colW) {
  const geomKey = `${colW}x${colH}`;
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

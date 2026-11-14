import { startChrome, CDP, sleep } from "./lib.mjs";

const url = process.argv[2] || "http://127.0.0.1:8644";
const size = process.argv[3] || "420,880";
const port = Number(process.argv[4] || 9389);

const chrome = await startChrome(port, size);
try {
  const cdp = await CDP.connect(port);
  await cdp.goto(url);
  await cdp.clickSel(".cover");
  await sleep(1000);
  const info = await cdp.eval(`(() => {
    const b = window.__dua.book;
    const nums = b.faces.filter((f) => f.kind === "page").map((f) => f.num);
    const missing = [];
    for (let n = 1; n <= Math.max(...nums); n++) if (!nums.includes(n)) missing.push(n);
    return {
      maxPage: b.maxPage(),
      pageFaces: nums.length,
      first: nums.slice(0, 5),
      last: nums.slice(-6),
      missing,
      dupes: nums.filter((n, i) => nums.indexOf(n) !== i),
      max: b.max, L: b.L, single: b.single,
    };
  })()`);
  console.log(JSON.stringify(info));
  const walk = await cdp.eval(`(async () => {
    const b = window.__dua.book;
    const seen = [];
    for (let s = 1; s <= b.max; s++) {
      b.gotoInstant(s);
      const els = document.elementsFromPoint(210, 440);
      const face = els.find((e) => e.classList && e.classList.contains("face") && e.classList.contains("page"));
      seen.push(face ? (face.querySelector(".folio") || {}).textContent ?? null : null);
      await new Promise((r) => setTimeout(r, 5));
    }
    const nums = seen.map((x) => parseInt(x, 10));
    const expected = Array.from({ length: b.max }, (_, i) => i + 1);
    return { ok: JSON.stringify(nums) === JSON.stringify(expected),
      bad: nums.map((n, i) => (n === expected[i] ? null : i + 1)).filter((x) => x).slice(0, 10) };
  })()`);
  console.log("walk all pages:", JSON.stringify(walk));
  const jump = await cdp.eval(`(() => {
    const b = window.__dua.book;
    const i = b.faceIndexByPage(84);
    if (i < 0) return { err: "no face 84" };
    b.gotoInstant(Math.ceil(i / 2));
    return { spread: window.__dua.state.spread,
      folios: [...document.querySelectorAll(".folio")].filter((f) => !f.closest(".leaf.dormant")).map((f) => f.textContent) };
  })()`);
  console.log("goto 84:", JSON.stringify(jump));
  await sleep(400);
  await cdp.shot("qa/shots/24-page84-probe.png");
  cdp.close();
} finally {
  chrome.kill();
}

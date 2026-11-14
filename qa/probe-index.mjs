import { startChrome, CDP, sleep } from "./lib.mjs";

const url = process.argv[2] || "http://127.0.0.1:8644";
const port = Number(process.argv[3] || 9394);

const chrome = await startChrome(port, "420,880");
try {
  const cdp = await CDP.connect(port);
  await cdp.goto(url);
  await cdp.clickSel(".cover");
  await sleep(1000);
  await cdp.key("i");
  await sleep(400);
  const idx = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll("#index-list li")].map((li) => ({
      name: li.querySelector(".idx-name").textContent,
      page: parseInt(li.querySelector(".idx-page").textContent, 10),
    }));
    const pages = rows.map((r) => r.page);
    return {
      count: rows.length,
      maxPage: window.__dua.book.maxPage(),
      ascending: pages.every((p, i) => i === 0 || p >= pages[i - 1]),
      min: Math.min(...pages),
      max: Math.max(...pages),
      anyZero: pages.some((p) => !p),
      first5: rows.slice(0, 5),
      last5: rows.slice(-5),
    };
  })()`);
  console.log(JSON.stringify(idx, null, 1));
  await cdp.shot("qa/shots/25-index-live.png");
  cdp.close();
} finally {
  chrome.kill();
}

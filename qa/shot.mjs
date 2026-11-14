import { startChrome, CDP, sleep } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const port = Number(args.port || 9333);
const chrome = await startChrome(port, args.size || "1440,900");
const cdp = await CDP.connect(port);
await cdp.goto(args.url);
if (args.steps) {
  const mod = await import(new URL(`./${args.steps}`, import.meta.url).href);
  await mod.default(cdp, sleep);
}
await cdp.shot(args.out);
cdp.close();
chrome.kill();
console.log("saved", args.out);

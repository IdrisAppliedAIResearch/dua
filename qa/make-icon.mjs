// Renders the book cover as a square app icon: icons/icon-1024.png, -512, -180.
// Reuses the app's own CSS + fonts so the icon is the real cover, not a mock.
// Run from the project root: node qa/make-icon.mjs
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { startChrome, CDP, sleep } from "./lib.mjs";

const CDP_PORT = 9397;
const SIZES = [1024, 512, 180];
const outDir = new URL("../web/icons/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const source = new URL("./icon-source.html", import.meta.url);
const page = "file:///" + source.pathname.replace(/^\//, "").replace(/\\/g, "/");

const chrome = await startChrome(CDP_PORT, "1024,1024");
try {
  const cdp = await CDP.connect(CDP_PORT);
  await cdp.cmd("Page.enable");
  await cdp.cmd("Runtime.enable");
  await cdp.cmd("Page.navigate", { url: page });
  await sleep(1500);
  for (const size of SIZES) {
    const { data } = await cdp.cmd("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width: 1024, height: 1024, scale: size / 1024 },
      captureBeyondViewport: true,
    });
    const file = new URL(`icon-${size}.png`, outDir);
    await writeFile(decodeURIComponent(file.pathname.replace(/^\//, "")), Buffer.from(data, "base64"));
    console.log("wrote", decodeURIComponent(file.pathname));
  }
  cdp.close();
} finally {
  chrome.kill();
}

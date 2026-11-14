import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME =
  process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

export async function startChrome(port, size = "1440,900") {
  const profile = (process.env.TEMP || "/tmp") + "/dua-chrome-" + port + "-" + Date.now();
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${size}`,
      "--hide-scrollbars",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (r.ok) return proc;
    } catch (_) {}
    await sleep(200);
  }
  throw new Error("chrome did not start");
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        this.exceptions.push(d.exception?.description || d.text);
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        this.exceptions.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
    });
  }

  static async connect(port) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r));
    return new CDP(ws);
  }

  cmd(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }

  async eval(expression) {
    const r = await this.cmd("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }

  async goto(url) {
    await this.cmd("Page.enable");
    await this.cmd("Runtime.enable");
    await this.cmd("Page.navigate", { url });
    for (let i = 0; i < 100; i++) {
      const ready = await this.eval("window.__duaReady === true");
      if (ready) return;
      await sleep(100);
    }
    throw new Error("app never became ready");
  }

  async shot(path) {
    const { data } = await this.cmd("Page.captureScreenshot", { format: "png" });
    await writeFile(path, Buffer.from(data, "base64"));
  }

  async center(sel, js = "el => el") {
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!box) throw new Error(`no element for ${sel}`);
    return box;
  }

  async click(x, y) {
    await this.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.cmd("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async clickSel(sel) {
    const { x, y } = await this.center(sel);
    await this.click(x, y);
  }

  async dblClickSel(sel) {
    const { x, y } = await this.center(sel);
    await this.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.cmd("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await this.cmd("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 2 });
    await this.cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 2 });
  }

  async key(key, extra = {}) {
    // noChar emulates a keypress whose text the browser suppressed (a handler
    // that preventDefaults keydown — which a real browser honors, but a CDP
    // "char" event bypasses): only keyDown/keyUp are delivered
    const { noChar, ...rest } = extra;
    const code = {
      Enter: "Enter", Escape: "Escape", " ": "Space", ArrowRight: "ArrowRight",
      ArrowLeft: "ArrowLeft", n: "KeyN", e: "KeyE", s: "KeyS", End: "End", Home: "Home",
      Backspace: "Backspace", Delete: "Delete",
    }[key] || "Key" + key.toUpperCase();
    const vk = {
      Enter: 13, Escape: 27, " ": 32, ArrowRight: 39, ArrowLeft: 37,
      n: 78, e: 69, s: 83, End: 35, Home: 36, Backspace: 8, Delete: 46,
    }[key] || key.toUpperCase().charCodeAt(0);
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.cmd("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...rest });
    if (!noChar && (rest.text !== undefined || (rest.unmodifiedText === undefined && key.length === 1))) {
      await this.cmd("Input.dispatchKeyEvent", {
        type: "char", key, text: rest.text ?? key, unmodifiedText: rest.text ?? key, ...base, ...rest,
      });
    }
    await this.cmd("Input.dispatchKeyEvent", { type: "keyUp", ...base, ...rest });
  }

  async type(text) {
    await this.cmd("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17,
      modifiers: 2,
    });
    await this.cmd("Input.dispatchKeyEvent", {
      type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2,
    });
    await this.cmd("Input.dispatchKeyEvent", {
      type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2,
    });
    await this.cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
    await this.cmd("Runtime.evaluate", {
      expression: `document.execCommand('insertText', false, ${JSON.stringify(text)})`,
    });
  }

  async waitIdle() {
    for (let i = 0; i < 80; i++) {
      const idle = await this.eval(
        "window.__dua && !window.__dua.book.busy && !document.querySelector('.leaf.animating')"
      );
      if (idle) return;
      await sleep(60);
    }
    throw new Error("book never went idle");
  }

  async waitFor(expr, timeoutMs = 8000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await this.eval(expr)) return true;
      await sleep(150);
    }
    return false;
  }

  close() {
    this.ws.close();
  }
}

export function assert(cond, label) {
  if (cond) {
    console.log(`ok    ${label}`);
  } else {
    console.log(`FAIL  ${label}`);
    process.exitCode = 1;
  }
}

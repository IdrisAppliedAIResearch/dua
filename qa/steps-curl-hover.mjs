export default async function (cdp, sleep) {
  await cdp.key("Enter");
  await sleep(950);
  await cdp.waitIdle();
  const r = await cdp.eval(
    "(() => { const b = document.querySelector('.face.cur-right').getBoundingClientRect(); return JSON.stringify({x: b.right - 20, y: b.bottom - 12}); })()"
  );
  const { x, y } = JSON.parse(r);
  await cdp.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.eval(
    "document.head.appendChild(Object.assign(document.createElement('style'), {textContent: '.face.cur-right .curl, .face.cur-left .curl {opacity: 1 !important}'}))"
  );
  await sleep(450);
  console.log(
    "diag:",
    await cdp.eval(`JSON.stringify({
      curlOpacity: getComputedStyle(document.querySelector('.face.cur-right .curl')).opacity,
    })`)
  );
}

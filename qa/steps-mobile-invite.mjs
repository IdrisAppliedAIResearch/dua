export default async function (cdp, sleep) {
  await cdp.cmd("Emulation.setDeviceMetricsOverride", {
    width: 420, height: 820, deviceScaleFactor: 1, mobile: true,
  });
  await cdp.eval("window.dispatchEvent(new Event('resize'))");
  await sleep(600);
  await cdp.clickSel(".cover");
  await sleep(950);
  await cdp.waitIdle();
  await sleep(300);
}

export default async function (cdp, sleep) {
  await cdp.key("Enter");
  await sleep(950);
  await cdp.waitIdle();
  const n = parseInt(process.env.TURNS || "0", 10);
  for (let i = 0; i < n; i++) {
    await cdp.key("ArrowRight");
    await sleep(820);
  }
  await sleep(300);
}

export default async function (cdp, sleep) {
  await cdp.key("Enter");
  await sleep(950);
}

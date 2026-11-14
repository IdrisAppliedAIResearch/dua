export default async function (cdp, sleep) {
  await cdp.key("Enter");
  await sleep(950);
  for (const text of [
    "First light on the lake this morning. The mist came off the water like paper burning.",
    "A quiet second day, mostly rain and reading. I reread half of Boswell and envied the eighteenth century its free time.",
  ]) {
    await cdp.key("i");
    await cdp.waitFor("!document.getElementById('index-overlay').hidden");
    await cdp.clickSel("#index-new");
    await cdp.waitFor("window.__dua.state.editing !== null");
    await cdp.waitIdle();
    await cdp.type(text);
    await cdp.key("s", { modifiers: 2, text: "s" });
    await cdp.waitFor("window.__dua.state.editing === null");
    await cdp.waitIdle();
  }
  await cdp.key("ArrowRight");
  await sleep(400);
}

async function assertExampleInvariant(frame, label='example') {
  const ok = await frame.evaluate(() => !!window.game?.started);
  if (!ok) throw new Error(label + ': game not started');
}
module.exports = { assertExampleInvariant };

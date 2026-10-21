/** Validate the frozen native evaluator's complete summary, without changing it. */
export function requireCompleteTracking(stdout, exitCode) {
  const plain = stdout.replace(/\u001b\[[0-9;]*m/g, '');
  const summaries = [...plain.matchAll(/^\s*RESULT: (\d+) passed, (\d+) failed, (\d+) skipped\s*$/gm)];
  if (exitCode !== 0 || summaries.length !== 1) {
    throw new Error(`Native tracking did not complete cleanly: exit=${exitCode}, summaries=${summaries.length}`);
  }
  const counts = summaries[0].slice(1).map(Number);
  if (counts[0] !== 109 || counts[1] !== 0 || counts[2] !== 0) {
    throw new Error(`Frozen native evaluator requires 109/0/0; received ${counts.join('/')}`);
  }
  return { passed: counts[0], failed: counts[1], skipped: counts[2] };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { requireCompleteTracking } from './tracking-summary.mjs';

test('accepts the complete native result, including ANSI color', () => {
  assert.deepEqual(requireCompleteTracking('\u001b[32m  RESULT: 109 passed, 0 failed, 0 skipped\u001b[0m\n', 0), { passed: 109, failed: 0, skipped: 0 });
});

for (const [name, text, exit] of [
  ['failure', 'RESULT: 108 passed, 1 failed, 0 skipped', 1],
  ['skip', 'RESULT: 108 passed, 0 failed, 1 skipped', 0],
  ['incomplete', 'RESULT: 108 passed, 0 failed, 0 skipped', 0],
  ['missing summary', 'browser started', 0],
  ['process failure despite summary', 'RESULT: 109 passed, 0 failed, 0 skipped', 2],
  ['duplicate summary', 'RESULT: 109 passed, 0 failed, 0 skipped\nRESULT: 0 passed, 1 failed, 0 skipped', 0],
]) {
  test(`rejects ${name}`, () => assert.throws(() => requireCompleteTracking(text, exit)));
}

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { requireCompleteTracking } from './tracking-summary.mjs';

const candidate = fs.realpathSync(process.env.GEV_CANDIDATE_ROOT);
const runtime = process.env.GEV_VALIDATION_RUNTIME;
fs.mkdirSync(runtime, { recursive: true });
const realRuntime = fs.realpathSync(runtime);
const expected = process.env.GEV_EXPECTED_HEAD;
const evaluatorHash = '00fac6e8d6db9ddd0984a2923afe81f343d190dcdd900174e692974795c54d86';
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8' }).trim();
const digest = () => createHash('sha256').update(fs.readFileSync(path.join(candidate, 'scripts/track-regression.mjs'))).digest('hex');
if (head() !== expected || digest() !== evaluatorHash) throw new Error('Frozen source/evaluator mismatch');
const preload = fileURLToPath(new URL('./tracking-preload.mjs', import.meta.url));
const env = { ...process.env, GEV_VALIDATION_RUNTIME: realRuntime, NODE_OPTIONS: `--import=${preload}`, NODE_COMPILE_CACHE: path.join(realRuntime, 'compile-cache') };
const receipt = { head: expected, evaluatorHash, node: process.version, start: new Date().toISOString(), command: ['npm', 'run', 'test:track', '--', '--url', 'http://127.0.0.1:43184', '--offline-imagery'], scope: 'Actual dev server and native evaluator; only documented offline imagery plus the approved provider-block/profile preload.' };
const owned = new Set();
const children = [];
let output = '';
let failure;
let initialBytes;
const size = (directory) => {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) total += size(name);
      else if (entry.isFile()) total += fs.statSync(name).size;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return total;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function captureChrome() {
  const file = path.join(realRuntime, 'chrome.jsonl');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  // A writer may be appending its last record; only complete lines are evidence.
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line) => {
    const row = JSON.parse(line);
    if (row.profile !== path.join(realRuntime, 'chrome-profile') || !children.some((child) => child.pid === row.ownerPgid)) throw new Error('Unowned Chrome record');
    owned.add(row.pgid);
    return row;
  });
}
function groupAlive(group) {
  try { process.kill(-group, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function launch(argv, logName, collect = false) {
  const child = spawn(argv[0], argv.slice(1), { cwd: candidate, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.argv = argv;
  if (child.pid) owned.add(child.pid);
  child.on('error', (error) => { child.spawnError = error; });
  children.push(child);
  const file = fs.createWriteStream(path.join(realRuntime, logName));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
    file.write(chunk);
    if (collect) { output += chunk.toString(); process.stdout.write(chunk); }
  });
  child.done = new Promise((resolve) => child.once('close', (code) => { file.end(); resolve(code); }));
  return child;
}
const begun = Date.now();
function guard() {
  captureChrome();
  for (const child of children) if (child.spawnError) throw child.spawnError;
  const stat = fs.statfsSync(realRuntime);
  const free = stat.bavail * stat.bsize;
  receipt.minimumFree = Math.min(receipt.minimumFree ?? free, free);
  const growth = size(realRuntime) - initialBytes;
  receipt.peakGeneratedBytes = Math.max(receipt.peakGeneratedBytes ?? 0, growth);
  if (free < 1024 ** 3 || growth > 150 * 1024 ** 2 || Date.now() - begun > 600000) throw new Error('Tracking resource/deadline guard');
}
try {
  if (fs.statfsSync(realRuntime).bavail * fs.statfsSync(realRuntime).bsize < 3 * 1024 ** 3) throw new Error('Tracking preflight requires 3 GiB');
  initialBytes = size(realRuntime);
  const server = launch(['npm', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '43184', '--strictPort'], 'server.log');
  let ready = false;
  for (let i = 0; i < 90; i++) {
    guard();
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('Dev server exited before readiness');
    try { const response = await fetch('http://127.0.0.1:43184/', { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } } catch {}
    await delay(500);
  }
  if (!ready) throw new Error('Actual dev server did not become ready');
  const track = launch(receipt.command, 'tracking.log', true);
  while (track.exitCode === null && track.signalCode === null) { guard(); await delay(500); }
  // Wait for stdout/stderr drains as well as process exit before parsing.
  await Promise.race([track.done, delay(5000).then(() => { throw new Error('Tracking output did not drain'); })]);
  receipt.nativeExit = track.exitCode;
  receipt.result = requireCompleteTracking(output, track.exitCode);
  if (head() !== expected || digest() !== evaluatorHash) throw new Error('Source/evaluator changed during tracking');
  const network = path.join(realRuntime, 'network.jsonl');
  if (fs.existsSync(network)) {
    const rows = fs.readFileSync(network, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    receipt.networkRequests = rows.length;
    if (rows.some((row) => row.kind.startsWith('blocked-provider'))) throw new Error('Unexpected forbidden-provider attempt; native fixtures should cover it');
  }
} catch (error) {
  failure = error;
  receipt.error = error.stack;
} finally {
  try { receipt.chrome = captureChrome(); } catch (error) { failure ??= error; receipt.ownershipError = error.stack; }
  const cleanup = [];
  for (const group of [...owned].reverse()) {
    try {
      if (groupAlive(group)) process.kill(-group, 'SIGTERM');
      for (let i = 0; i < 25 && groupAlive(group); i++) await delay(200);
      if (groupAlive(group)) process.kill(-group, 'SIGKILL');
      for (let i = 0; i < 25 && groupAlive(group); i++) await delay(200);
      const gone = !groupAlive(group);
      cleanup.push({ group, gone });
      if (!gone) throw new Error(`Owned group ${group} remains`);
    } catch (error) { failure ??= error; cleanup.push({ group, error: error.stack }); }
  }
  receipt.cleanup = cleanup;
  if (cleanup.every((row) => row.gone === true)) {
    const profile = path.join(realRuntime, 'chrome-profile');
    fs.rmSync(profile, { recursive: true, force: true });
    receipt.profileRemoved = !fs.existsSync(profile);
  } else {
    receipt.profileRemoved = false;
  }
  receipt.finished = new Date().toISOString();
  receipt.passed = !failure;
  fs.writeFileSync(path.join(realRuntime, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  if (failure) console.error(failure.stack);
}
process.exitCode = failure ? 1 : 0;

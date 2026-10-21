import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(
  new URL('../../scripts/docker-healthcheck.mjs', import.meta.url),
);

async function probe(port) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, PORT: String(port), HOST: '0.0.0.0' },
    stdio: 'ignore',
    timeout: 6000,
  });
  const [code, signal] = await once(child, 'exit');
  assert.equal(
    signal,
    null,
    'probe must exit before the outer process deadline',
  );
  return code;
}

async function serve(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  });
  return server.address().port;
}

test('healthy local HTTP listener passes on the configured port', async (t) => {
  const port = await serve(t, (req, res) => {
    assert.equal(req.url, '/');
    res.end('<!doctype html><title>fixture</title>');
  });
  assert.equal(await probe(port), 0);
});

for (const status of [404, 500]) {
  test(`HTTP ${status} marks the container unhealthy`, async (t) => {
    const port = await serve(t, (_req, res) => {
      res.writeHead(status);
      res.end();
    });
    assert.equal(await probe(port), 1);
  });
}

test('an absent listener fails rather than reporting a running process healthy', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  assert.equal(await probe(port), 1);
});

test('an unresponsive local listener fails within the probe deadline', async (t) => {
  const port = await serve(t, () => {});
  assert.equal(await probe(port), 1);
});

test('redirects are not followed to another origin', async (t) => {
  let destinationHits = 0;
  const destination = await serve(t, (_req, res) => {
    destinationHits += 1;
    res.end('healthy');
  });
  const port = await serve(t, (_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${destination}/` });
    res.end();
  });
  assert.equal(await probe(port), 1);
  assert.equal(destinationHits, 0);
});

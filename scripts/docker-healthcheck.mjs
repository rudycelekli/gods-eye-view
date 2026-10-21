#!/usr/bin/env node
// Probe the listener inside the container; this does not call a data provider.
const port = Number.parseInt(process.env.PORT, 10) || 4173;
try {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
  });
  await response.body?.cancel();
  if (!response.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}

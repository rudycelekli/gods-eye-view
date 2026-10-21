#!/usr/bin/env node
// Always connect directly to the container, even with environment proxies enabled.
import { get } from 'node:http';

const port = Number.parseInt(process.env.PORT, 10) || 4173;
const request = get(
  {
    hostname: '127.0.0.1',
    port,
    path: '/',
    agent: false,
    signal: AbortSignal.timeout(3000),
  },
  (response) => {
    response.destroy();
    if (response.statusCode < 200 || response.statusCode >= 300)
      process.exitCode = 1;
  },
);
request.on('error', () => {
  process.exitCode = 1;
});

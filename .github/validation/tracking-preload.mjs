import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const candidate = fs.realpathSync(process.env.GEV_CANDIDATE_ROOT);
const runtime = fs.realpathSync(process.env.GEV_VALIDATION_RUNTIME);
const require = createRequire(path.join(candidate, 'package.json'));
const { default: puppeteer } = await import(pathToFileURL(require.resolve('puppeteer')));
const profile = path.join(runtime, 'chrome-profile');
const forbidden = (raw) => {
  try { return /(^|\.)(?:thespacedevs\.com|celestrak\.(?:org|com))$/.test(new URL(raw).hostname); }
  catch { return false; }
};
const log = (kind, raw) => {
  let url;
  try { url = new URL(raw); } catch { return; }
  if (['http:', 'https:'].includes(url.protocol)) {
    fs.appendFileSync(path.join(runtime, 'network.jsonl'), JSON.stringify({ kind, origin: url.origin, path: url.pathname, pid: process.pid }) + '\n');
  }
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  log(forbidden(url) ? 'blocked-provider-fetch' : 'node-fetch', url);
  if (forbidden(url)) return Promise.reject(new Error('Validation forbids live LL2/CelesTrak calls'));
  return originalFetch(input, init);
};
const launch = puppeteer.launch.bind(puppeteer);
puppeteer.launch = async (options = {}) => {
  if (options.userDataDir && options.userDataDir !== profile) throw new Error('Unexpected browser profile');
  const browser = await launch({ ...options, userDataDir: profile, args: [...(options.args || []), '--disable-component-update', '--disable-background-networking', '--disk-cache-size=8388608', '--media-cache-size=1048576'] });
  try {
    const pid = browser.process().pid;
    const pgid = Number(execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim());
    const ownerPgid = Number(execFileSync('ps', ['-p', String(process.pid), '-o', 'pgid='], { encoding: 'utf8' }).trim());
    const argv = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
    if (!argv.includes(profile)) throw new Error('Browser ownership/profile mismatch');
    fs.appendFileSync(path.join(runtime, 'chrome.jsonl'), JSON.stringify({ pid, pgid, profile, ownerPid: process.pid, ownerPgid, version: await browser.version() }) + '\n');
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await newPage(...args);
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: ['*://*.thespacedevs.com/*', '*://thespacedevs.com/*', '*://celestrak.org/*', '*://*.celestrak.org/*', '*://celestrak.com/*', '*://*.celestrak.com/*'] });
      page.on('request', (request) => log(forbidden(request.url()) ? 'blocked-provider-browser' : 'browser-request', request.url()));
      return page;
    };
    return browser;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
};

/**
 * The 30-minute stale-session sweep in src/http-server.ts.
 *
 * Split out of `http-transport.test.ts` because it needs FAKE TIMERS installed before the
 * module is imported -- the cleanup `setInterval` and the `Date.now()` the sweep compares
 * against are both created inside `main()`, so a timer faked afterwards would never see them.
 *
 * `setTimeout`/`setImmediate`/`nextTick`/`queueMicrotask` are deliberately left real: a live
 * HTTP server and its sockets run on them, and faking them deadlocks the request below. Only
 * the interval and the clock are faked, which is exactly what the sweep uses.
 *
 * Requests here go through `node:http` rather than global `fetch` so no undici timer of its
 * own can interact with the faked clock. Port 0 is used; 8106 is never bound.
 */

import * as http from 'node:http';

import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Sweeps that still leave the session inside its idle window (5 -> 25 minutes). */
const SWEEPS_INSIDE_WINDOW = SESSION_TIMEOUT_MS / CLEANUP_INTERVAL_MS - 1;

jest.mock('../src/config-loader.js', () => ({
  __esModule: true,
  loadConfiguration: jest.fn(async () => undefined),
  hasInlineEnvVars: () => false,
}));

jest.mock('../src/server.js', () => ({
  __esModule: true,
  createConfluenceServer: jest.fn(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
    return new Server(
      { name: 'confluence-cloud', version: 'test' },
      { capabilities: { tools: {}, resources: {} } }
    );
  }),
}));

const listens: http.Server[] = [];
const realListen = http.Server.prototype.listen;
const realSetTimeout = globalThis.setTimeout;

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'timeout-test', version: '0.0.0' },
  },
});

describe('stale session cleanup', () => {
  let port: number;
  let server: http.Server;

  beforeAll(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    jest.useFakeTimers({
      doNotFake: [
        'setTimeout',
        'clearTimeout',
        'setImmediate',
        'clearImmediate',
        'nextTick',
        'queueMicrotask',
      ],
    });
    jest.setSystemTime(new Date('2026-08-25T12:00:00Z'));

    http.Server.prototype.listen = function patched(this: http.Server, ...args: unknown[]) {
      listens.push(this);
      return (realListen as (...a: unknown[]) => http.Server).apply(this, args);
    } as typeof http.Server.prototype.listen;

    process.env.PORT = '0';
    await import('../src/http-server.js');

    await waitFor(() => listens.length > 0, 'listen()');
    server = listens[0];
    await waitFor(() => server.listening, 'the server to listen');
    port = (server.address() as { port: number }).port;
    expect(port).not.toBe(8106);
  });

  afterAll(async () => {
    http.Server.prototype.listen = realListen;
    jest.useRealTimers();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function activeSessions(): Promise<number> {
    const response = await request(port, 'GET', '/health');
    return JSON.parse(response.body).activeSessions;
  }

  it('evicts a session idle past the 30 minute timeout on the next sweep', async () => {
    const created = await request(
      port,
      'POST',
      '/mcp',
      { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      INITIALIZE
    );
    const sessionId = created.headers['mcp-session-id'] as string;

    expect(sessionId).toBeTruthy();
    expect(await activeSessions()).toBe(1);

    // Five sweeps -- 25 minutes idle. Still inside the window, so the session survives.
    await jest.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS * SWEEPS_INSIDE_WINDOW);
    expect(await activeSessions()).toBe(1);

    // Two more -- 35 minutes idle. The sweep evicts it.
    await jest.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS * 2);
    expect(await activeSessions()).toBe(0);

    const afterEviction = await request(
      port,
      'POST',
      '/mcp',
      {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    );

    expect(afterEviction.status).toBe(404);
    expect(afterEviction.body).toContain('Session not found');
  });

  it('leaves a session alive indefinitely while it keeps making requests', async () => {
    const created = await request(
      port,
      'POST',
      '/mcp',
      { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      INITIALIZE
    );
    const sessionId = created.headers['mcp-session-id'] as string;

    await request(
      port,
      'POST',
      '/mcp',
      {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    );

    // Well over a full timeout period in total, but touched inside each window.
    for (let i = 0; i < 2; i += 1) {
      await jest.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS * SWEEPS_INSIDE_WINDOW);

      const ping = await request(
        port,
        'POST',
        '/mcp',
        {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
        },
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })
      );
      expect(ping.status).toBe(200);
    }

    expect(await activeSessions()).toBe(1);

    await request(port, 'DELETE', '/mcp', { 'mcp-session-id': sessionId });
    expect(await activeSessions()).toBe(0);
  });
});

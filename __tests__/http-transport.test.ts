/**
 * HTTP transport (src/http-server.ts) -- session lifecycle, session isolation, `/health`,
 * the stale-session sweep and CLI/env port selection. Previously 0%.
 *
 * WHY THIS FILE EXISTS AT ALL: no unit test in this repo instantiated a transport before it.
 * That is not a theoretical gap -- a dotenv v17 upgrade during this project would have printed
 * to stdout and silently corrupted every STDIO JSON-RPC session, and only a hand-run smoke
 * test caught it. A broken transport passed 610 tests.
 *
 * `src/http-server.ts` exports nothing and calls `main()` on import, so it is driven exactly
 * the way PM2 drives it: imported for real, over a real socket, with real HTTP requests. Two
 * seams make that safe and hermetic:
 *
 *   1. `http.Server.prototype.listen` is patched to record every bind and, in the port-parsing
 *      tests, to record the requested port WITHOUT binding it. PORT=0 is set before every
 *      binding import, so the OS assigns an ephemeral port. Port 8106 -- where a real PM2
 *      process lives -- is never bound.
 *   2. `../src/config-loader.js` and `../src/server.js` are mocked, so no config file is read,
 *      no `.env` is loaded, and no Confluence client is ever constructed.
 */

import * as http from 'node:http';

import { jest, describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

const loadConfiguration = jest.fn(async () => undefined);

jest.mock('../src/config-loader.js', () => ({
  __esModule: true,
  loadConfiguration,
  hasInlineEnvVars: () => false,
}));

/**
 * A stand-in for the real factory: a minimal but genuine MCP `Server`, so the transport does
 * real protocol work while nothing in `src/server.ts`'s handler graph -- and therefore nothing
 * that reads `~/.confluence-config.json` or constructs an axios client -- is loaded here.
 * `src/server.ts` has its own suite.
 */
const createConfluenceServer = jest.fn(() => {
  // Required lazily: this factory runs inside the module under test, after mocks are in place.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

  const server = new Server(
    { name: 'confluence-cloud', version: 'test' },
    { capabilities: { tools: {}, resources: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'probe', description: 'probe', inputSchema: { type: 'object' } }],
  }));
  return server;
});

jest.mock('../src/server.js', () => ({
  __esModule: true,
  createConfluenceServer,
}));

// ---------------------------------------------------------------------------
// listen() interception
// ---------------------------------------------------------------------------

interface ListenRecord {
  server: http.Server;
  args: unknown[];
}

const listens: ListenRecord[] = [];
let allowBind = true;

const realListen = http.Server.prototype.listen;

beforeAll(() => {
  http.Server.prototype.listen = function patchedListen(this: http.Server, ...args: unknown[]) {
    listens.push({ server: this, args });
    if (!allowBind) {
      return this;
    }
    return (realListen as (...a: unknown[]) => http.Server).apply(this, args);
  } as typeof http.Server.prototype.listen;
});

afterAll(() => {
  http.Server.prototype.listen = realListen;
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
}

/** Captured before any test can install fake timers. */
const realSetTimeout = globalThis.setTimeout;

interface Harness {
  baseUrl: string;
  server: http.Server;
  stop: () => Promise<void>;
}

/** Import `http-server.ts` fresh, let it bind an ephemeral port, and return its address. */
async function start(): Promise<Harness> {
  const before = listens.length;
  process.env.PORT = '0';
  delete process.env.CONFLUENCE_CONFIG_PATH;

  await jest.isolateModulesAsync(async () => {
    await import('../src/http-server.js');
  });

  await waitFor(() => listens.length > before, 'the HTTP server to call listen()');
  const server = listens[listens.length - 1].server;
  await waitFor(() => server.listening, 'the HTTP server to start listening');

  const address = server.address() as { port: number };
  expect(address.port).not.toBe(8106); // never disturb the PM2 instance

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    stop: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const JSON_RPC_ACCEPT = 'application/json, text/event-stream';

interface McpResponse {
  status: number;
  sessionId?: string;
  contentType: string | null;
  body: any;
}

/** POST a JSON-RPC message and normalise the SSE-or-JSON reply the SDK may send. */
async function postMcp(harness: Harness, body: unknown, sessionId?: string): Promise<McpResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: JSON_RPC_ACCEPT,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const response = await fetch(`${harness.baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const contentType = response.headers.get('content-type');

  let parsed: any;
  if (contentType?.includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    parsed = line ? JSON.parse(line.slice('data:'.length).trim()) : undefined;
  } else if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id') ?? undefined,
    contentType,
    body: parsed,
  };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'transport-test', version: '0.0.0' },
  },
};

async function openSession(harness: Harness): Promise<string> {
  const response = await postMcp(harness, INITIALIZE);
  expect(response.status).toBe(200);
  expect(response.sessionId).toBeTruthy();

  // The spec requires the initialized notification before ordinary requests.
  await postMcp(
    harness,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    response.sessionId
  );

  return response.sessionId!;
}

async function health(harness: Harness): Promise<any> {
  const response = await fetch(`${harness.baseUrl}/health`);
  expect(response.status).toBe(200);
  return response.json();
}

// ---------------------------------------------------------------------------

describe('HTTP transport', () => {
  let harness: Harness;

  beforeAll(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    harness = await start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  afterEach(() => {
    createConfluenceServer.mockClear();
  });

  describe('/health', () => {
    it('reports the server identity and transport without needing a session', async () => {
      const body = await health(harness);

      expect(body).toMatchObject({
        status: 'ok',
        server: 'confluence-cloud-mcp',
        transport: 'streamable-http',
      });
      expect(typeof body.uptime).toBe('number');
      expect(typeof body.activeSessions).toBe('number');
    });

    it('loads configuration once at startup, not per request', async () => {
      await health(harness);
      await health(harness);
      expect(loadConfiguration).toHaveBeenCalledTimes(1);
    });
  });

  describe('request rejection', () => {
    it('rejects a first POST that is not an initialize request', async () => {
      const response = await postMcp(harness, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('first request must be an initialization');
      expect(response.body.error.code).toBe(-32000);
      expect(createConfluenceServer).not.toHaveBeenCalled();
    });

    it('rejects an unknown session id as expired rather than silently reinitialising', async () => {
      const response = await postMcp(
        harness,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        '00000000-0000-4000-8000-000000000000'
      );

      expect(response.status).toBe(404);
      expect(response.body.error.message).toContain('Session not found');
      expect(createConfluenceServer).not.toHaveBeenCalled();
    });

    it('rejects a GET with no session id', async () => {
      const response = await fetch(`${harness.baseUrl}/mcp`, {
        headers: { accept: 'text/event-stream' },
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toContain('invalid session ID');
    });

    it('rejects a GET with an unknown session id', async () => {
      const response = await fetch(`${harness.baseUrl}/mcp`, {
        headers: {
          accept: 'text/event-stream',
          'mcp-session-id': '00000000-0000-4000-8000-000000000000',
        },
      });
      expect(response.status).toBe(400);
    });

    it('rejects a DELETE with no session id', async () => {
      const response = await fetch(`${harness.baseUrl}/mcp`, { method: 'DELETE' });
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toContain('invalid session ID');
    });

    it('rejects a DELETE for an unknown session id', async () => {
      const response = await fetch(`${harness.baseUrl}/mcp`, {
        method: 'DELETE',
        headers: { 'mcp-session-id': '00000000-0000-4000-8000-000000000000' },
      });
      expect(response.status).toBe(400);
    });
  });

  describe('session lifecycle', () => {
    it('creates a session on initialize and hands back its id', async () => {
      const response = await postMcp(harness, INITIALIZE);

      expect(response.status).toBe(200);
      expect(response.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.body.result.serverInfo.name).toBe('confluence-cloud');

      await fetch(`${harness.baseUrl}/mcp`, {
        method: 'DELETE',
        headers: { 'mcp-session-id': response.sessionId! },
      });
    });

    it('routes a follow-up request to the session that owns it', async () => {
      const sessionId = await openSession(harness);

      const response = await postMcp(
        harness,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        sessionId
      );

      expect(response.status).toBe(200);
      expect(response.body.result.tools[0].name).toBe('probe');

      await fetch(`${harness.baseUrl}/mcp`, {
        method: 'DELETE',
        headers: { 'mcp-session-id': sessionId },
      });
    });

    it('counts live sessions in /health and decrements on close', async () => {
      const before = (await health(harness)).activeSessions;

      const sessionId = await openSession(harness);
      expect((await health(harness)).activeSessions).toBe(before + 1);

      const closed = await fetch(`${harness.baseUrl}/mcp`, {
        method: 'DELETE',
        headers: { 'mcp-session-id': sessionId },
      });

      expect(closed.status).toBe(200);
      expect(await closed.json()).toEqual({ status: 'session closed' });
      expect((await health(harness)).activeSessions).toBe(before);
    });

    it('refuses a request on a session that has been closed', async () => {
      const sessionId = await openSession(harness);
      await fetch(`${harness.baseUrl}/mcp`, {
        method: 'DELETE',
        headers: { 'mcp-session-id': sessionId },
      });

      const response = await postMcp(
        harness,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        sessionId
      );
      expect(response.status).toBe(404);
    });
  });

  describe('session isolation', () => {
    it('builds a SEPARATE Server instance per session', async () => {
      // This is the server-per-session invariant: the SDK's Server.connect() allows one
      // transport per Server, so sharing one instance across HTTP sessions would cross-wire
      // two Claude Code projects onto the same connection.
      const first = await openSession(harness);
      const second = await openSession(harness);

      expect(first).not.toBe(second);
      expect(createConfluenceServer).toHaveBeenCalledTimes(2);

      const [a, b] = createConfluenceServer.mock.results.map((r) => r.value);
      expect(a).not.toBe(b);

      for (const sessionId of [first, second]) {
        await fetch(`${harness.baseUrl}/mcp`, {
          method: 'DELETE',
          headers: { 'mcp-session-id': sessionId },
        });
      }
    });

    it('keeps both sessions independently usable', async () => {
      const first = await openSession(harness);
      const second = await openSession(harness);

      const a = await postMcp(harness, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, first);
      const b = await postMcp(harness, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, second);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);

      // Closing one must not disturb the other.
      await fetch(`${harness.baseUrl}/mcp`, {
        method: 'DELETE',
        headers: { 'mcp-session-id': first },
      });

      const stillAlive = await postMcp(
        harness,
        { jsonrpc: '2.0', id: 10, method: 'tools/list' },
        second
      );
      expect(stillAlive.status).toBe(200);

      await fetch(`${harness.baseUrl}/mcp`, {
        method: 'DELETE',
        headers: { 'mcp-session-id': second },
      });
    });
  });

  describe('batched initialize', () => {
    it('accepts an initialize sent inside a JSON-RPC batch', async () => {
      // `checkInitializeRequest` walks arrays for exactly this case.
      const response = await postMcp(harness, [INITIALIZE]);
      expect(response.status).not.toBe(400);
    });

    it('rejects a batch that contains no initialize request', async () => {
      const response = await postMcp(harness, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('first request must be an initialization');
    });
  });
});

describe('port selection', () => {
  /**
   * These imports record the port the module ASKED for without binding it, so no port other
   * than the ephemeral one above is ever occupied -- 8106 included.
   */
  const savedArgv = process.argv;
  const savedPort = process.env.PORT;

  async function requestedPort(argv: string[], port?: string): Promise<number> {
    const before = listens.length;
    process.argv = ['node', 'http-server.js', ...argv];
    if (port === undefined) delete process.env.PORT;
    else process.env.PORT = port;

    allowBind = false;
    try {
      await jest.isolateModulesAsync(async () => {
        await import('../src/http-server.js');
      });
      await waitFor(() => listens.length > before, 'listen() to be called');
    } finally {
      allowBind = true;
    }
    return listens[listens.length - 1].args[0] as number;
  }

  beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    process.argv = savedArgv;
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  });

  it('defaults to 8106 when nothing says otherwise', async () => {
    await expect(requestedPort([])).resolves.toBe(8106);
  });

  it('reads PORT from the environment', async () => {
    await expect(requestedPort([], '9411')).resolves.toBe(9411);
  });

  it('prefers --port=N over PORT', async () => {
    await expect(requestedPort(['--port=9412'], '9411')).resolves.toBe(9412);
  });

  it('accepts --port N as two arguments', async () => {
    await expect(requestedPort(['--port', '9413'], '9411')).resolves.toBe(9413);
  });

  it.each([['--port=0'], ['--port=65536'], ['--port=nonsense']])(
    'falls back to PORT when %s is out of range or unparseable',
    async (arg) => {
      await expect(requestedPort([arg], '9411')).resolves.toBe(9411);
    }
  );

  it('binds loopback only, never a public interface', async () => {
    await requestedPort([], '9411');
    expect(listens[listens.length - 1].args[1]).toBe('127.0.0.1');
  });
});

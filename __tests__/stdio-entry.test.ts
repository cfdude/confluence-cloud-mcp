/**
 * STDIO entry point (src/index.ts) -- and specifically, that NOTHING pollutes stdout.
 *
 * This is the regression the transport-and-client-coverage epic was named after. Under STDIO,
 * stdout IS the JSON-RPC channel: a single stray line written to it desynchronises the framing
 * and every subsequent message is discarded by the client. During this project a `dotenv` v17
 * upgrade would have printed its startup banner to stdout at module load and silently
 * corrupted every Claude Desktop session. Nothing in the 610-test suite noticed; a hand-run
 * smoke test caught it.
 *
 * The assertion below is therefore about a SIDE EFFECT OF IMPORTING, not about a return value:
 * import the entry point for real, with only the transport itself stubbed, and require that
 * stdout stayed silent. Any dependency that starts printing a banner, a deprecation notice or
 * a "tip" fails this immediately.
 *
 * `console.error` is deliberately NOT silenced into a spy that hides regressions: it is
 * captured and asserted to be the only channel used.
 */

import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';

const stdoutWrites: string[] = [];
const stdoutConsoleCalls: string[] = [];
const stderrConsoleCalls: string[] = [];

const connect = jest.fn(async () => undefined);
const close = jest.fn(async () => undefined);

const createConfluenceServer = jest.fn(() => ({ connect, close }));

jest.mock('../src/server.js', () => ({
  __esModule: true,
  createConfluenceServer,
}));

/**
 * The real transport would hijack process.stdin/stdout for the lifetime of the test run.
 * Stubbing it is what makes importing the entry point safe; it does not weaken the assertion,
 * because the pollution this file guards against happens at MODULE LOAD, before connect().
 */
const StdioServerTransport = jest.fn(() => ({}));

jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  __esModule: true,
  StdioServerTransport,
}));

describe('STDIO entry point', () => {
  let restoreStdout: () => void;

  beforeAll(async () => {
    const realStdoutWrite = process.stdout.write.bind(process.stdout);

    // Raw writes -- what a dependency printing its own banner without `console` would do.
    process.stdout.write = ((chunk: any, ...rest: any[]) => {
      stdoutWrites.push(String(chunk));
      return realStdoutWrite(chunk, ...rest);
    }) as typeof process.stdout.write;
    restoreStdout = () => {
      process.stdout.write = realStdoutWrite;
    };

    // Console-routed writes. Jest replaces `console` with its own reporter-backed instance, so
    // a `console.log` never reaches `process.stdout.write` under test even though it would in
    // production. Both channels are captured so neither route can slip through.
    for (const method of ['log', 'info', 'debug', 'warn'] as const) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        stdoutConsoleCalls.push(`${method}: ${args.map(String).join(' ')}`);
      });
    }
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderrConsoleCalls.push(args.map(String).join(' '));
    });

    // `loadConfiguration` runs for real here on purpose -- dotenv is loaded inside it, and
    // dotenv is exactly the dependency whose stdout behaviour this file exists to police.
    await import('../src/index.js');

    // main() is async and floating; give it a turn to reach the ready banner.
    for (let i = 0; i < 20 && connect.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  afterAll(() => {
    restoreStdout();
    jest.restoreAllMocks();
  });

  it('writes NOTHING to stdout while starting up', () => {
    // If this fails, read the captured text before touching the test: a dependency has started
    // printing to stdout and every STDIO JSON-RPC session is corrupted in production.
    expect(stdoutWrites.join('')).toBe('');
  });

  it('routes nothing through console.log/info/debug/warn either', () => {
    // `console.warn` counts: it lands on stdout in some runtimes, and none of these belong on
    // the protocol channel regardless. stderr is the only safe place to talk.
    expect(stdoutConsoleCalls).toEqual([]);
  });

  it('connects the server to a STDIO transport', () => {
    expect(StdioServerTransport).toHaveBeenCalledTimes(1);
    expect(createConfluenceServer).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('announces readiness on stderr, which is not the protocol channel', () => {
    expect(stderrConsoleCalls.join('\n')).toContain('Confluence Cloud MCP server running on stdio');
  });

  it('did not report a fatal startup error', () => {
    expect(stderrConsoleCalls.join('\n')).not.toContain('Fatal error:');
  });

  it('installs a SIGINT handler so the server closes rather than being killed mid-write', () => {
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(0);
  });
});

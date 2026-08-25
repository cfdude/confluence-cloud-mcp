/**
 * ConfluenceClient (src/client/confluence-client.ts) -- every Confluence API call in the
 * server, previously at 13.87% statement coverage.
 *
 * MOCKING APPROACH: the REAL axios is used, with `axios.defaults.adapter` swapped for a fake
 * transport. `axios.create()` merges `axios.defaults` at construction time, so an adapter
 * installed before `new ConfluenceClient(...)` is inherited by both the v2 and v1 instances.
 *
 * This is deliberately not `jest.mock('axios')`. Keeping real axios keeps the real
 * interceptor plumbing, the real `AxiosError`/`isAxiosError` pair and the real config merge,
 * which is precisely the machinery the error-mapping and rate-limit assertions are about. A
 * hand-built axios double would let those assertions pass against a fiction.
 *
 * CONSEQUENCE, and the reason auth is asserted on the CONFIG rather than on a header: the
 * `auth: { username, password }` option is turned into an `Authorization` header by axios's
 * http/xhr adapters, which are exactly what this fake replaces. Header construction proper is
 * covered by `confluence-api.test.ts`.
 *
 * No test here touches the network.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import axios, { AxiosError } from 'axios';

import { ConfluenceClient } from '../src/client/confluence-client.js';
import { ConfluenceApiError, ConfluenceError } from '../src/types/index.js';
import type { ConfluenceConfig } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

interface FakeCall {
  method: string;
  baseURL: string;
  url: string;
  fullUrl: string;
  params: Record<string, unknown>;
  body: any;
  headers: Record<string, string>;
  auth?: { username?: string; password?: string };
}

interface Reply {
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
}

type Responder = (call: FakeCall, index: number) => Reply;

let calls: FakeCall[];
let responder: Responder;
let previousAdapter: unknown;

function describeCall(config: any): FakeCall {
  const rawHeaders =
    typeof config.headers?.toJSON === 'function' ? config.headers.toJSON() : config.headers;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders ?? {})) {
    headers[key.toLowerCase()] = String(value);
  }

  let body: any;
  if (typeof config.data === 'string') {
    try {
      body = JSON.parse(config.data);
    } catch {
      body = config.data;
    }
  } else {
    body = config.data;
  }

  return {
    method: String(config.method ?? 'get').toUpperCase(),
    baseURL: config.baseURL ?? '',
    url: config.url ?? '',
    fullUrl: `${config.baseURL ?? ''}${config.url ?? ''}`,
    params: config.params ?? {},
    body,
    headers,
    auth: config.auth,
  };
}

beforeEach(() => {
  calls = [];
  responder = () => ({ status: 200, data: {} });
  previousAdapter = axios.defaults.adapter;
  axios.defaults.adapter = (async (config: any) => {
    const call = describeCall(config);
    const index = calls.length;
    calls.push(call);

    const reply = responder(call, index);
    const response = {
      data: reply.data ?? {},
      status: reply.status,
      statusText: String(reply.status),
      headers: reply.headers ?? {},
      config,
      request: {},
    };
    if (reply.status >= 200 && reply.status < 300) {
      return response;
    }
    throw new AxiosError(
      `Request failed with status code ${reply.status}`,
      AxiosError.ERR_BAD_REQUEST,
      config,
      {},
      response as any
    );
  }) as any;

  // The constructor and handleError both log verbosely.
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  axios.defaults.adapter = previousAdapter as any;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

/** Reply to every request with the same thing. */
function always(reply: Reply): void {
  responder = () => reply;
}

/** Reply to requests in order; the last entry repeats once exhausted. */
function inOrder(...replies: Reply[]): void {
  responder = (_call, index) => replies[Math.min(index, replies.length - 1)];
}

const BASIC: ConfluenceConfig = {
  domain: 'example.atlassian.net',
  auth: { type: 'basic', email: 'user@example.com', apiToken: 'secret-token' },
};

const V2 = 'https://example.atlassian.net/wiki/api/v2';
const V1 = 'https://example.atlassian.net/wiki/rest/api';

function client(config: Partial<ConfluenceConfig> = {}): ConfluenceClient {
  return new ConfluenceClient({ ...BASIC, ...config } as ConfluenceConfig);
}

function v2Page(overrides: Record<string, unknown> = {}) {
  return {
    id: '15106417',
    status: 'current',
    title: 'Quarterly Plan',
    spaceId: '65601',
    version: { number: 7, createdAt: '2026-02-02T00:00:00.000Z', authorId: 'a', minorEdit: false },
    _links: { webui: '/spaces/APA/pages/15106417' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('constructor', () => {
  it('refuses to build a client with no domain', () => {
    expect(() => new ConfluenceClient({ auth: BASIC.auth } as ConfluenceConfig)).toThrow(
      'Domain is required'
    );
  });

  it('splits the v2 and v1 base URLs across two axios instances', async () => {
    always({ status: 200, data: { results: [] } });
    const c = client();

    await c.getConfluenceSpace('1'); // v2
    await c.searchContentV1('type = page'); // v1

    expect(calls[0].baseURL).toBe(V2);
    expect(calls[1].baseURL).toBe(V1);
  });

  it('sends the default User-Agent when none is configured', async () => {
    always({ status: 200, data: {} });
    await client().getConfluenceSpace('1');
    expect(calls[0].headers['user-agent']).toBe('Confluence-Cloud-MCP/2.0');
  });

  it('honours a configured User-Agent on both API versions', async () => {
    always({ status: 200, data: { results: [] } });
    const c = client({ userAgent: 'my-agent/1.0' });

    await c.getConfluenceSpace('1');
    await c.searchContentV1('x');

    expect(calls[0].headers['user-agent']).toBe('my-agent/1.0');
    expect(calls[1].headers['user-agent']).toBe('my-agent/1.0');
  });

  it('adds the XSRF opt-out header to v1 only', async () => {
    always({ status: 200, data: { results: [] } });
    const c = client();

    await c.getConfluenceSpace('1');
    await c.searchContentV1('x');

    expect(calls[0].headers['x-atlassian-token']).toBeUndefined();
    expect(calls[1].headers['x-atlassian-token']).toBe('no-check');
  });

  it('passes the configured email and API token as basic credentials', async () => {
    always({ status: 200, data: { results: [] } });
    const c = client();

    await c.getConfluenceSpace('1');
    await c.searchContentV1('x');

    expect(calls[0].auth).toEqual({ username: 'user@example.com', password: 'secret-token' });
    expect(calls[1].auth).toEqual({ username: 'user@example.com', password: 'secret-token' });
  });

  it('sends the OAuth2 access token as a Bearer header', async () => {
    // Regression. This test previously PINNED the bug: `auth` was hardcoded to
    // {username: email, password: apiToken} regardless of auth.type, so an oauth2 config sent
    // NO credentials at all and Confluence answered 401, surfaced as a bare "Failed to connect
    // to Confluence API". The only Bearer-header builder lived in utils/confluence-api.ts,
    // which nothing imports. OAuth2 is documented in README.md and CLAUDE.md.
    always({ status: 200, data: {} });
    const c = client({
      auth: { type: 'oauth2', accessToken: 'oauth-access-token' },
    });

    await c.getConfluenceSpace('1');
    await c.searchContentV1('x');

    for (const call of calls) {
      expect(call.headers['Authorization'] ?? call.headers['authorization']).toBe(
        'Bearer oauth-access-token'
      );
      // An empty `auth` object would make axios strip the Bearer header.
      expect(call.auth).toBeUndefined();
    }
  });
});

describe('verifyApiConnection', () => {
  it('probes /spaces once and caches the verdict for later list calls', async () => {
    always({ status: 200, data: { results: [], _links: {} } });
    const c = client();

    await c.getConfluenceSpaces();
    await c.getConfluenceSpaces();

    // probe + list, then list only.
    expect(calls).toHaveLength(3);
    expect(calls[0].params).toEqual({ limit: 1 });
    expect(calls[1].params).toMatchObject({ limit: 25 });
    expect(calls[2].params).toMatchObject({ limit: 25 });
  });

  it.each([401, 403, 404, 418, 500, 503])(
    'collapses a %i to the generic message, losing the status-specific diagnosis',
    async (status) => {
      // BUG #1, documented rather than fixed -- see the `v2 interceptor` block below for the
      // root cause. `verifyApiConnection` branches on `isAxiosError(error)` to produce
      // "Authentication failed: Invalid API token or email" for a 401, "Authorization failed"
      // for a 403 and so on. The v2 response interceptor has already replaced the AxiosError
      // with a ConfluenceApiError by then, so `isAxiosError` is false and EVERY status --
      // including the 401 that means "your API token is wrong" -- reaches the operator as the
      // undiagnosable "Failed to connect to Confluence API".
      always({ status, data: { message: 'raw' } });
      await expect(client().verifyApiConnection()).rejects.toThrow(
        'Failed to connect to Confluence API'
      );
    }
  );

  it('reports a generic failure for a non-axios error', async () => {
    responder = () => {
      throw new Error('DNS blew up');
    };
    await expect(client().verifyApiConnection()).rejects.toThrow(
      'Failed to connect to Confluence API'
    );
  });
});

describe('v2 interceptor: the AxiosError is replaced before any method sees it', () => {
  /**
   * ROOT CAUSE of several documented bugs in this file, kept in one place.
   *
   * The v2 client's rejection interceptor ends `throw this.handleError(error)`, which returns
   * a `ConfluenceApiError`. Every v2 method that later asks `isAxiosError(error)` therefore
   * gets FALSE, and every branch behind that question -- status-specific messages, v1
   * fallbacks, ConfluenceError code mapping -- is unreachable in production.
   *
   * The v1 client has no interceptor at all, which is why the same patterns work there
   * (getPageContent, searchConfluenceContent, moveConfluencePage all map correctly).
   *
   * Not fixed here: this epic is tests-only, and the fix -- letting the interceptor rethrow
   * the AxiosError, or teaching each method to recognise ConfluenceApiError -- changes the
   * error type crossing the handler boundary and needs its own change with its own review.
   */

  it('hands methods a ConfluenceApiError, never an AxiosError, for a v2 failure', async () => {
    always({ status: 403, data: { message: 'nope' } });

    const error = await client()
      .getConfluenceSpace('1')
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConfluenceApiError);
    expect(axios.isAxiosError(error)).toBe(false);
  });

  it('hands methods a raw AxiosError for a v1 failure', async () => {
    always({ status: 403, data: { message: 'nope' } });

    const error = await client()
      .searchContentV1('type = page')
      .catch((e) => e);

    expect(axios.isAxiosError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ConfluenceApiError);
  });

  it('converts even a non-axios v2 transport failure into a ConfluenceApiError', async () => {
    responder = () => {
      throw new TypeError('adapter imploded');
    };

    const error = await client()
      .getConfluenceSpace('1')
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConfluenceApiError);
    expect(error.status).toBeUndefined();
    expect(error.message).toContain('adapter imploded');
  });
});

describe('error mapping', () => {
  /**
   * `updateConfluencePage` and `getConfluenceSpace` have no try/catch of their own, so the
   * interceptor's ConfluenceApiError reaches the caller intact. That is the path the
   * write-safety layer depends on: design.md D12 classifies a version conflict by STATUS, and
   * a message-only heuristic is not good enough for a write path.
   */

  it('preserves the HTTP status so a version conflict stays classifiable', async () => {
    always({ status: 409, data: { message: 'Version mismatch' } });

    const error = await client()
      .updateConfluencePage('1', 'T', '<p>x</p>', 8)
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConfluenceApiError);
    expect(error.status).toBe(409);
    expect(error.message).toContain('Version mismatch');
    expect(error.responseData).toEqual({ message: 'Version mismatch' });
  });

  it('falls back to the raw payload when the body carries no message', async () => {
    always({ status: 400, data: { errors: [{ title: 'bad body' }] } });

    const error = await client()
      .updateConfluencePage('1', 'T', '<p>x</p>', 8)
      .catch((e) => e);

    expect(error.status).toBe(400);
    expect(error.message).toContain('bad body');
  });

  it.each([401, 403, 404, 500, 503])(
    'maps a %i into a ConfluenceApiError carrying that status',
    async (status) => {
      // 429 is excluded on purpose: the retry interceptor swallows it and retries forever.
      // See the `429 backoff` block.
      always({ status, data: { message: 'x' } });

      const error = await client()
        .updateConfluencePage('1', 'T', '<p>x</p>', 8)
        .catch((e) => e);

      expect(error).toBeInstanceOf(ConfluenceApiError);
      expect(error.status).toBe(status);
    }
  );

  it('reports an undefined status when the request never got a response', async () => {
    responder = () => {
      throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, {} as any);
    };

    const error = await client()
      .updateConfluencePage('1', 'T', '<p>x</p>', 8)
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConfluenceApiError);
    expect(error.status).toBeUndefined();
    expect(error.message).toContain('Network Error');
  });

  it('DISCARDS the status when the failure is a page READ', async () => {
    // BUG #2: `getConfluencePage` wraps its body in a try/catch that asks
    // `isAxiosError(error)` before calling `handleError`. Since the interceptor already
    // converted the error (see the `v2 interceptor` block), that test fails and the method
    // falls through to `throw new Error('Failed to fetch page content')` -- so a 404 on a
    // missing page, a 403 on a restricted one and a 500 are indistinguishable to the caller.
    always({ status: 404, data: { message: 'Page not found' } });

    const error = await client()
      .getConfluencePage('1')
      .catch((e) => e);

    expect(error).not.toBeInstanceOf(ConfluenceApiError);
    expect(error.message).toBe('Failed to fetch page content');
    expect(error.status).toBeUndefined();
  });

  it('reports a non-axios failure as a plain fetch error', async () => {
    responder = () => {
      throw new Error('adapter imploded');
    };

    await expect(client().getConfluencePage('1')).rejects.toThrow('Failed to fetch page content');
  });
});

describe('rate limit tracking', () => {
  it('starts at zero before any request', () => {
    expect(client().getRateLimitInfo()).toEqual({ limit: 0, remaining: 0, resetTime: 0 });
  });

  it('records the rate-limit headers from a successful v2 response', async () => {
    always({
      status: 200,
      data: {},
      headers: {
        'x-ratelimit-limit': '1000',
        'x-ratelimit-remaining': '997',
        'x-ratelimit-reset': '1893456000000',
      },
    });
    const c = client();
    await c.getConfluenceSpace('1');

    expect(c.getRateLimitInfo()).toEqual({
      limit: 1000,
      remaining: 997,
      resetTime: 1893456000000,
    });
  });

  it('treats missing rate-limit headers as zero rather than NaN', async () => {
    always({ status: 200, data: {}, headers: {} });
    const c = client();
    await c.getConfluenceSpace('1');

    expect(c.getRateLimitInfo()).toEqual({ limit: 0, remaining: 0, resetTime: 0 });
  });

  it('hands back a copy, so a caller cannot corrupt the client state', async () => {
    always({ status: 200, data: {}, headers: { 'x-ratelimit-remaining': '5' } });
    const c = client();
    await c.getConfluenceSpace('1');

    const snapshot = c.getRateLimitInfo();
    snapshot.remaining = 999;

    expect(c.getRateLimitInfo().remaining).toBe(5);
  });

  it('does NOT track rate limits on v1 responses', async () => {
    // Asymmetry, documented: the response interceptor is attached to the v2 client only, so
    // search, page-content reads, moves and label fallbacks contribute nothing to the counter.
    always({ status: 200, data: { results: [] }, headers: { 'x-ratelimit-remaining': '3' } });
    const c = client();
    await c.searchContentV1('type = page');

    expect(c.getRateLimitInfo().remaining).toBe(0);
  });
});

describe('429 backoff', () => {
  it('waits and retries the v2 request, then returns the retry result', async () => {
    jest.useFakeTimers();
    inOrder(
      { status: 429, data: { message: 'slow down' }, headers: { 'x-ratelimit-reset': '0' } },
      { status: 200, data: v2Page({ body: { storage: { value: '<p>hi</p>' } } }) }
    );

    const c = client();
    const pending = c.getConfluencePage('15106417');
    await jest.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toMatchObject({ id: '15106417' });
    expect(calls).toHaveLength(2);
    expect(calls[1].fullUrl).toBe(`${V2}/pages/15106417`);
    expect(calls[1].method).toBe('GET');
  });

  it('waits at least one second even when the reset time has already passed', async () => {
    jest.useFakeTimers();
    inOrder(
      { status: 429, data: {}, headers: { 'x-ratelimit-reset': '0' } },
      { status: 200, data: v2Page({ body: { storage: { value: '<p>hi</p>' } } }) }
    );

    const c = client();
    const pending = c.getConfluencePage('1');

    await jest.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(calls).toHaveLength(2);
  });

  it('waits until the reset time when it is further out than the one-second floor', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    inOrder(
      { status: 429, data: {}, headers: { 'x-ratelimit-reset': '5000' } },
      { status: 200, data: v2Page({ body: { storage: { value: '<p>hi</p>' } } }) }
    );

    const c = client();
    const pending = c.getConfluencePage('1');

    await jest.advanceTimersByTimeAsync(4999);
    expect(calls).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(calls).toHaveLength(2);
  });

  it('retries with no cap, so a persistently rate-limited endpoint loops', async () => {
    // Documented, not fixed: the interceptor re-issues the request unconditionally and the
    // retry re-enters the same interceptor. There is no attempt counter and no ceiling on the
    // wait; a server stuck on 429 keeps the call alive indefinitely. Bounded here to three
    // rounds purely so the test terminates.
    jest.useFakeTimers();
    responder = (_call, index) =>
      index < 3
        ? { status: 429, data: {}, headers: { 'x-ratelimit-reset': '0' } }
        : { status: 200, data: v2Page({ body: { storage: { value: '<p>hi</p>' } } }) };

    const c = client();
    const pending = c.getConfluencePage('1');

    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await pending;

    expect(calls).toHaveLength(4);
  });

  it('does NOT retry a 429 on the v1 client', async () => {
    // The interceptor is installed on the v2 instance only.
    always({ status: 429, data: { message: 'slow down' } });

    await expect(client().searchContentV1('type = page')).rejects.toMatchObject({
      isAxiosError: true,
    });
    expect(calls).toHaveLength(1);
  });
});

describe('space operations', () => {
  it('requests spaces with plain descriptions and the caller options', async () => {
    inOrder({ status: 200, data: { results: [] } });
    await client().getConfluenceSpaces({
      limit: 50,
      cursor: 'abc',
      sort: '-name',
      status: 'archived',
    });

    expect(calls[1].fullUrl).toBe(`${V2}/spaces`);
    expect(calls[1].params).toEqual({
      limit: 50,
      cursor: 'abc',
      sort: '-name',
      status: 'archived',
      'description-format': 'plain',
    });
  });

  it('defaults the page size to 25', async () => {
    always({ status: 200, data: { results: [] } });
    await client().getConfluenceSpaces();
    expect(calls[1].params).toMatchObject({ limit: 25 });
  });

  it('fetches a single space by id without a verification probe', async () => {
    always({ status: 200, data: { id: '65601' } });
    await client().getConfluenceSpace('65601');

    expect(calls).toHaveLength(1);
    expect(calls[0].fullUrl).toBe(`${V2}/spaces/65601`);
    expect(calls[0].params).toEqual({ 'description-format': 'plain' });
  });
});

describe('page listing and lookup', () => {
  it('lists pages in a space in storage format', async () => {
    always({ status: 200, data: { results: [] } });
    await client().getConfluencePages('65601', {
      limit: 10,
      cursor: 'c',
      title: 'Plan',
      status: 'current',
      sort: '-modified-date',
    });

    expect(calls[0].fullUrl).toBe(`${V2}/pages`);
    expect(calls[0].params).toEqual({
      'space-id': '65601',
      limit: 10,
      cursor: 'c',
      title: 'Plan',
      status: 'current',
      sort: '-modified-date',
      'body-format': 'storage',
    });
  });

  it('searches by exact title, scoped to a space when one is given', async () => {
    always({ status: 200, data: { results: [v2Page()] } });
    const pages = await client().searchPageByName('Quarterly Plan', '65601');

    expect(calls[0].params).toEqual({
      title: 'Quarterly Plan',
      status: 'current',
      limit: 10,
      'space-id': '65601',
    });
    expect(pages).toHaveLength(1);
  });

  it('omits the space filter when no space is given', async () => {
    always({ status: 200, data: { results: [] } });
    await client().searchPageByName('Quarterly Plan');
    expect(calls[0].params).not.toHaveProperty('space-id');
  });

  it('leaks a ConfluenceApiError from a title search instead of its UNKNOWN mapping', async () => {
    // BUG #3: `searchPageByName` catches and maps to `ConfluenceError(..., 'UNKNOWN')` behind
    // an `isAxiosError` test the v2 interceptor has already invalidated, so the mapping never
    // runs. Harmless today -- callers treat both as failures -- but the branch is dead.
    always({ status: 500, data: { message: 'boom' } });

    const error = await client()
      .searchPageByName('Quarterly Plan')
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConfluenceApiError);
    expect(error).not.toBeInstanceOf(ConfluenceError);
    expect(error.status).toBe(500);
  });

  it('reports PAGE_NOT_FOUND when no page carries the title', async () => {
    always({ status: 200, data: { results: [] } });

    const error = await client()
      .findConfluencePageByTitle('Nope')
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConfluenceError);
    expect(error.code).toBe('PAGE_NOT_FOUND');
  });

  it('reports MULTIPLE_MATCHES rather than guessing between same-titled pages', async () => {
    always({ status: 200, data: { results: [v2Page(), v2Page({ id: '2' })] } });

    const error = await client()
      .findConfluencePageByTitle('Quarterly Plan')
      .catch((e) => e);

    expect(error.code).toBe('MULTIPLE_MATCHES');
    expect(error.message).toContain('Please specify a space ID');
  });

  it('fetches the full page when the title matches exactly one', async () => {
    responder = (call) =>
      call.url === '/pages'
        ? { status: 200, data: { results: [v2Page()] } }
        : { status: 200, data: v2Page({ body: { storage: { value: '<p>body</p>' } } }) };

    const page = await client().findConfluencePageByTitle('Quarterly Plan');

    expect(page.body.storage.value).toBe('<p>body</p>');
    expect(calls[1].fullUrl).toBe(`${V2}/pages/15106417`);
  });
});

describe('getConfluencePage', () => {
  it('returns the v2 payload directly when it already carries storage body', async () => {
    always({ status: 200, data: v2Page({ body: { storage: { value: '<p>body</p>' } } }) });

    const page = await client().getConfluencePage('15106417');

    expect(page.body.storage.value).toBe('<p>body</p>');
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({ 'body-format': 'storage' });
  });

  it('falls back to the v1 content endpoint when v2 returns no body', async () => {
    responder = (_call, index) =>
      index === 0
        ? { status: 200, data: v2Page() }
        : { status: 200, data: { body: { storage: { value: '<p>from v1</p>' } } } };

    const page = await client().getConfluencePage('15106417');

    expect(calls[1].fullUrl).toBe(`${V1}/content/15106417`);
    expect(calls[1].params).toEqual({ expand: 'body.storage' });
    expect(page.body).toEqual({
      storage: { value: '<p>from v1</p>', representation: 'storage' },
    });
    expect(page.title).toBe('Quarterly Plan');
  });

  it('returns metadata alone for a page whose body is genuinely empty', async () => {
    responder = (_call, index) =>
      index === 0 ? { status: 200, data: v2Page() } : { status: 200, data: { body: {} } };

    const page = await client().getConfluencePage('15106417');

    expect(page.id).toBe('15106417');
    expect(page.body).toBeUndefined();
  });

  it('flattens a non-EMPTY_CONTENT failure from the v1 fallback', async () => {
    // Same shape as BUG #2: `getPageContent` correctly raises
    // `ConfluenceError('INSUFFICIENT_PERMISSIONS')`, the inner catch correctly rethrows it
    // because it is not EMPTY_CONTENT -- and then the OUTER catch's `isAxiosError` test fails
    // and flattens it to a bare `Failed to fetch page content`. The code is lost.
    responder = (_call, index) =>
      index === 0 ? { status: 200, data: v2Page() } : { status: 403, data: { message: 'nope' } };

    const error = await client()
      .getConfluencePage('15106417')
      .catch((e) => e);

    expect(error).not.toBeInstanceOf(ConfluenceError);
    expect(error.message).toBe('Failed to fetch page content');
  });
});

describe('getPageContent', () => {
  it('returns the storage body from the v1 endpoint', async () => {
    always({ status: 200, data: { body: { storage: { value: '<p>hello</p>' } } } });
    await expect(client().getPageContent('1')).resolves.toBe('<p>hello</p>');
  });

  it.each([
    [404, 'PAGE_NOT_FOUND'],
    [403, 'INSUFFICIENT_PERMISSIONS'],
    [500, 'UNKNOWN'],
  ])('maps a %i to %s', async (status, code) => {
    always({ status, data: { message: 'x' } });

    const error = await client()
      .getPageContent('1')
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConfluenceError);
    expect(error.code).toBe(code);
  });

  it('reports an empty body as EMPTY_CONTENT rather than an empty string', async () => {
    always({ status: 200, data: { body: { storage: { value: '' } } } });

    const error = await client()
      .getPageContent('1')
      .catch((e) => e);

    expect(error.code).toBe('EMPTY_CONTENT');
  });

  it('rethrows a non-axios failure unchanged', async () => {
    responder = () => {
      throw new TypeError('adapter imploded');
    };
    await expect(client().getPageContent('1')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('page writes', () => {
  it('creates a page with storage representation and the given parent', async () => {
    always({ status: 200, data: v2Page() });
    await client().createConfluencePage('65601', 'New Page', '<p>hi</p>', '999');

    expect(calls[0].method).toBe('POST');
    expect(calls[0].fullUrl).toBe(`${V2}/pages`);
    expect(calls[0].body).toEqual({
      spaceId: '65601',
      status: 'current',
      title: 'New Page',
      parentId: '999',
      body: { representation: 'storage', value: '<p>hi</p>' },
    });
  });

  it('omits parentId when creating at the space root', async () => {
    always({ status: 200, data: v2Page() });
    await client().createConfluencePage('65601', 'New Page', '<p>hi</p>');
    expect(calls[0].body).not.toHaveProperty('parentId');
  });

  it('submits the version number it is given, doing no arithmetic of its own', async () => {
    // Regression guard: an earlier signature forwarded a caller-supplied version verbatim
    // while the tool description told the agent to increment it -- an off-by-one that
    // surfaced as an undiagnosable 409. Version resolution belongs to the write-safety layer.
    always({ status: 200, data: v2Page() });
    await client().updateConfluencePage('15106417', 'Quarterly Plan', '<p>new</p>', 8);

    expect(calls[0].method).toBe('PUT');
    expect(calls[0].fullUrl).toBe(`${V2}/pages/15106417`);
    expect(calls[0].body).toEqual({
      id: '15106417',
      status: 'current',
      title: 'Quarterly Plan',
      body: { representation: 'storage', value: '<p>new</p>' },
      version: { number: 8, message: 'Updated via API' },
    });
  });
});

describe('label operations', () => {
  it('reads labels from the v2 endpoint', async () => {
    always({ status: 200, data: { results: [] } });
    await client().getConfluenceLabels('15106417');
    expect(calls[0].fullUrl).toBe(`${V2}/pages/15106417/labels`);
  });

  it('adds a label through v2 when v2 accepts it', async () => {
    always({ status: 200, data: { id: '1', name: 'reviewed' } });
    await client().addConfluenceLabel('15106417', 'reviewed');

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].fullUrl).toBe(`${V2}/pages/15106417/labels`);
    expect(calls[0].body).toEqual({ name: 'reviewed' });
  });

  it('never reaches the v1 label fallback on a v2 404', async () => {
    // BUG #4: the v1 fallback is guarded by `isAxiosError(error) && status === 404`, which the
    // v2 interceptor has already made unreachable. Only ONE request is issued and the caller
    // gets a raw ConfluenceApiError. If a Confluence deployment ever lacks the v2 label route,
    // the documented fallback will not save it.
    inOrder(
      { status: 404, data: { message: 'no such route' } },
      { status: 200, data: { id: '1' } }
    );

    const error = await client()
      .addConfluenceLabel('15106417', 'reviewed', 'my')
      .catch((e) => e);

    expect(calls).toHaveLength(1);
    expect(calls[0].baseURL).toBe(V2);
    expect(error).toBeInstanceOf(ConfluenceApiError);
    expect(error.status).toBe(404);
  });

  it.each([400, 403, 404, 409, 500])(
    'leaks a %i on add as a ConfluenceApiError instead of its ConfluenceError code',
    async (status) => {
      // Same root cause: INVALID_LABEL / PERMISSION_DENIED / PAGE_NOT_FOUND / LABEL_EXISTS are
      // all dead branches. The handler above this layer branches on `error.code ===
      // 'LABEL_EXISTS'` to return InvalidRequest, so "label already exists" reaches the agent
      // as an InternalError instead.
      always({ status, data: { message: 'x' } });

      const error = await client()
        .addConfluenceLabel('1', 'x')
        .catch((e) => e);

      expect(error).toBeInstanceOf(ConfluenceApiError);
      expect(error).not.toBeInstanceOf(ConfluenceError);
      expect(error.status).toBe(status);
    }
  );

  it('converts a non-axios add failure into a ConfluenceApiError too', async () => {
    responder = () => {
      throw new TypeError('adapter imploded');
    };
    await expect(client().addConfluenceLabel('1', 'x')).rejects.toBeInstanceOf(ConfluenceApiError);
  });

  it('removes a label through v2 when v2 accepts it', async () => {
    always({ status: 204, data: {} });
    await client().removeConfluenceLabel('15106417', 'reviewed');

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].fullUrl).toBe(`${V2}/pages/15106417/labels/reviewed`);
  });

  it('never reaches the v1 label-removal fallback on a v2 404', async () => {
    inOrder({ status: 404, data: { message: 'x' } }, { status: 204, data: {} });

    const error = await client()
      .removeConfluenceLabel('15106417', 'reviewed')
      .catch((e) => e);

    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(ConfluenceApiError);
  });

  it.each([403, 404, 500])(
    'leaks a %i on remove as a ConfluenceApiError instead of its ConfluenceError code',
    async (status) => {
      always({ status, data: { message: 'x' } });

      const error = await client()
        .removeConfluenceLabel('1', 'x')
        .catch((e) => e);

      expect(error).toBeInstanceOf(ConfluenceApiError);
      expect(error).not.toBeInstanceOf(ConfluenceError);
      expect(error.status).toBe(status);
    }
  );

  it('converts a non-axios remove failure into a ConfluenceApiError too', async () => {
    responder = () => {
      throw new TypeError('adapter imploded');
    };
    await expect(client().removeConfluenceLabel('1', 'x')).rejects.toBeInstanceOf(
      ConfluenceApiError
    );
  });
});

describe('searchConfluenceContent', () => {
  const searchPayload = {
    results: [
      {
        content: {
          id: '15106417',
          type: 'page',
          status: 'current',
          title: 'Quarterly Plan',
          space: { id: '65601' },
          version: { when: '2026-02-02T00:00:00.000Z' },
          _links: { webui: '/spaces/APA/pages/15106417' },
        },
        excerpt: 'a plan',
      },
    ],
    start: 0,
    limit: 25,
    size: 1,
    _links: { self: '/rest/api/search', next: '/rest/api/search?cursor=x' },
  };

  it('sends the CQL through unchanged and expands the fields the handlers read', async () => {
    always({ status: 200, data: searchPayload });
    await client().searchConfluenceContent('space = "APA" AND type = page');

    expect(calls[0].fullUrl).toBe(`${V1}/search`);
    expect(calls[0].params).toEqual({
      cql: 'space = "APA" AND type = page',
      limit: 25,
      start: 0,
      expand: 'content.space,content.version,content.body.view.value',
    });
  });

  it('wraps a plain-text query in a text ~ clause', async () => {
    always({ status: 200, data: searchPayload });
    await client().searchConfluenceContent('quarterly plan', { plainText: true });
    expect(calls[0].params.cql).toBe('text ~ "quarterly plan"');
  });

  it('escapes backslashes and quotes in a plain-text query', async () => {
    always({ status: 200, data: searchPayload });
    await client().searchConfluenceContent('C:\\path "quoted"', { plainText: true });
    expect(calls[0].params.cql).toBe('text ~ "C:\\\\path \\"quoted\\""');
  });

  it('does not escape a CQL query, which is the caller\u2019s to get right', async () => {
    always({ status: 200, data: searchPayload });
    await client().searchConfluenceContent('title ~ "a \\"b\\""');
    expect(calls[0].params.cql).toBe('title ~ "a \\"b\\""');
  });

  it('composes an absolute URL from the instance domain', async () => {
    always({ status: 200, data: searchPayload });
    const result = await client().searchConfluenceContent('x');

    expect(result.results[0].url).toBe(
      'https://example.atlassian.net/wiki/spaces/APA/pages/15106417'
    );
    expect(result.results[0].content.spaceId).toBe('65601');
    expect(result.results[0].lastModified).toBe('2026-02-02T00:00:00.000Z');
    expect(result.results[0].excerpt).toBe('a plan');
  });

  it('forwards limit and start, defaulting them to 25 and 0', async () => {
    always({ status: 200, data: searchPayload });
    await client().searchConfluenceContent('x', { limit: 5, start: 50 });
    expect(calls[0].params).toMatchObject({ limit: 5, start: 50 });
  });

  it('substitutes defaults for a response missing its pagination envelope', async () => {
    always({ status: 200, data: {} });
    const result = await client().searchConfluenceContent('x');

    expect(result).toMatchObject({ results: [], start: 0, limit: 25, size: 0 });
    expect(result._links.self).toBe('');
  });

  it('maps a search failure to SEARCH_FAILED, which the handler turns into InvalidRequest', async () => {
    always({ status: 400, data: { message: 'bad cql' } });

    const error = await client()
      .searchConfluenceContent('bad ~~ cql')
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConfluenceError);
    expect(error.code).toBe('SEARCH_FAILED');
  });

  it('rethrows a non-axios search failure unchanged', async () => {
    responder = () => {
      throw new TypeError('adapter imploded');
    };
    await expect(client().searchConfluenceContent('x')).rejects.toBeInstanceOf(TypeError);
  });

  it('passes searchContentV1 straight through without mapping', async () => {
    always({ status: 200, data: searchPayload });
    const result = await client().searchContentV1('type = page', { limit: 10, start: 5 });

    expect(calls[0].params).toEqual({
      cql: 'type = page',
      limit: 10,
      start: 5,
      expand: 'content.space,content.version',
    });
    expect(result).toEqual(searchPayload);
  });
});

describe('setContentProperty', () => {
  it('writes through v2 when v2 accepts it', async () => {
    always({ status: 200, data: {} });
    await client().setContentProperty('15106417', 'my-key', { a: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].fullUrl).toBe(`${V2}/pages/15106417/properties/my-key`);
    expect(calls[0].body).toEqual({ key: 'my-key', value: { a: 1 } });
  });

  it('never reaches the v1 property fallback on a v2 404', async () => {
    inOrder({ status: 404, data: { message: 'x' } }, { status: 200, data: {} });

    const error = await client()
      .setContentProperty('15106417', 'my-key', { a: 1 })
      .catch((e) => e);

    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(ConfluenceApiError);
  });

  it('leaks a ConfluenceApiError instead of PROPERTY_SET_FAILED', async () => {
    always({ status: 403, data: { message: 'x' } });

    const error = await client()
      .setContentProperty('1', 'k', 1)
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConfluenceApiError);
    expect(error).not.toBeInstanceOf(ConfluenceError);
    expect(error.status).toBe(403);
  });

  it('converts a non-axios property failure into a ConfluenceApiError too', async () => {
    responder = () => {
      throw new TypeError('adapter imploded');
    };
    await expect(client().setContentProperty('1', 'k', 1)).rejects.toBeInstanceOf(
      ConfluenceApiError
    );
  });
});

describe('moveConfluencePage', () => {
  it('moves via the v1 endpoint, defaulting the position to append', async () => {
    always({ status: 200, data: {} });
    await client().moveConfluencePage('15106417', '999');

    expect(calls[0].method).toBe('PUT');
    expect(calls[0].fullUrl).toBe(`${V1}/content/15106417/move/append/999`);
    expect(calls[0].headers['atl-confluence-with-admin-key']).toBe('true');
  });

  it.each(['before', 'after'] as const)('puts the %s position in the path', async (position) => {
    always({ status: 200, data: {} });
    await client().moveConfluencePage('15106417', '999', position);
    expect(calls[0].fullUrl).toBe(`${V1}/content/15106417/move/${position}/999`);
  });

  it.each([
    [404, 'PAGE_NOT_FOUND'],
    [403, 'ACCESS_DENIED'],
    [400, 'INVALID_REQUEST'],
    [500, 'MOVE_FAILED'],
  ])('maps a %i to %s', async (status, code) => {
    always({ status, data: { message: 'x' } });

    const error = await client()
      .moveConfluencePage('1', '2')
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConfluenceError);
    expect(error.code).toBe(code);
  });

  it('names both page ids in the not-found message', async () => {
    always({ status: 404, data: { message: 'x' } });

    const error = await client()
      .moveConfluencePage('15106417', '999')
      .catch((e) => e);

    expect(error.message).toContain('15106417');
    expect(error.message).toContain('999');
  });

  it('surfaces the API explanation on a 400', async () => {
    always({ status: 400, data: { message: 'target is a descendant' } });

    const error = await client()
      .moveConfluencePage('1', '2')
      .catch((e) => e);

    expect(error.message).toContain('target is a descendant');
  });

  it('rethrows a non-axios move failure unchanged', async () => {
    responder = () => {
      throw new TypeError('adapter imploded');
    };
    await expect(client().moveConfluencePage('1', '2')).rejects.toBeInstanceOf(TypeError);
  });
});

// ---------------------------------------------------------------------------
// OAuth2 authentication -- regression for a documented feature that never worked
// ---------------------------------------------------------------------------

describe('authentication credential validation', () => {
  it('rejects an OAuth2 config with no access token, naming the variable to set', () => {
    expect(() => client({ auth: { type: 'oauth2' } })).toThrow(/CONFLUENCE_OAUTH_ACCESS_TOKEN/);
  });

  it('rejects a basic config missing either credential', () => {
    expect(() => client({ auth: { type: 'basic', email: 'user@example.com' } })).toThrow(
      /CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN/
    );
    expect(() => client({ auth: { type: 'basic', apiToken: 'api-token' } })).toThrow(
      /CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN/
    );
  });
});

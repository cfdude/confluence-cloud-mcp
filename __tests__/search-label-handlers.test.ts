/**
 * Search and label handlers (src/handlers/search-label-handlers.ts).
 *
 * The pure `extractCursor` helper is covered by `search-cursor.test.ts`; this file covers the
 * four HANDLERS, which is where the interesting behaviour lives: the response reduction, the
 * page->instance caching side effect that makes later pageId-only calls resolvable, and the
 * ConfluenceError -> McpError code mapping.
 *
 * The client, `../src/config.js` and the instance cache are mocked in the style established
 * by `page-write-handlers.test.ts`.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const searchConfluenceContent = jest.fn<(cql: string, options?: unknown) => Promise<any>>();
const getConfluenceLabels = jest.fn<(pageId: string) => Promise<any>>();
const addConfluenceLabel =
  jest.fn<(pageId: string, label: string, prefix?: string) => Promise<any>>();
const removeConfluenceLabel = jest.fn<(pageId: string, label: string) => Promise<void>>();

const cachePageInstance = jest.fn(async () => undefined);

jest.mock('../src/client/confluence-client.js', () => ({
  __esModule: true,
  ConfluenceClient: jest.fn().mockImplementation(() => ({
    searchConfluenceContent,
    getConfluenceLabels,
    addConfluenceLabel,
    removeConfluenceLabel,
  })),
}));

jest.mock('../src/config.js', () => ({
  __esModule: true,
  getInstanceForSpace: jest.fn(async () => ({ instanceName: 'onvex', config: {} })),
  getSpaceConfig: jest.fn(async () => undefined),
  instanceToConfluenceConfig: jest.fn(() => ({
    domain: 'example.atlassian.net',
    auth: { type: 'basic', email: 'user@example.com', apiToken: 'token' },
  })),
}));

jest.mock('../src/utils/instance-cache.js', () => ({
  __esModule: true,
  cachePageInstance,
  getInstanceForPageId: jest.fn(async () => null),
}));

import {
  handleAddConfluenceLabel,
  handleGetConfluenceLabels,
  handleRemoveConfluenceLabel,
  handleSearchConfluencePages,
} from '../src/handlers/search-label-handlers.js';
import { ConfluenceApiError, ConfluenceError } from '../src/types/index.js';

function parse(result: { content: Array<{ type: string; text: string }> }): any {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  return JSON.parse(result.content[0].text);
}

function hit(overrides: Record<string, unknown> = {}) {
  return {
    content: {
      id: '15106417',
      type: 'page',
      status: 'current',
      title: 'Quarterly Plan',
      spaceId: '65601',
      _links: { webui: '/spaces/APA/pages/15106417' },
    },
    url: 'https://example.atlassian.net/wiki/spaces/APA/pages/15106417',
    lastModified: '2026-02-02T00:00:00.000Z',
    excerpt: 'a plan for the quarter',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('handleSearchConfluencePages', () => {
  it('reduces each hit and echoes the CQL and instance back', async () => {
    searchConfluenceContent.mockResolvedValue({
      results: [hit()],
      start: 0,
      limit: 25,
      size: 1,
      _links: { self: '/rest/api/search' },
    });

    const body = parse(await handleSearchConfluencePages({ cql: 'space = "APA"' }));

    expect(body.instance).toBe('onvex');
    expect(body.cql).toBe('space = "APA"');
    expect(body.results).toEqual([
      {
        id: '15106417',
        type: 'page',
        title: 'Quarterly Plan',
        spaceId: '65601',
        excerpt: 'a plan for the quarter',
        lastModified: '2026-02-02T00:00:00.000Z',
        url: '/spaces/APA/pages/15106417',
      },
    ]);
  });

  it('reports the relative webui path as `url`, not the absolute link the client built', async () => {
    // Documented, not endorsed: the client composes an absolute `result.url`, and the handler
    // then overwrites it with the RELATIVE `_links.webui`. An agent cannot open the result
    // without knowing the instance domain.
    searchConfluenceContent.mockResolvedValue({
      results: [hit()],
      start: 0,
      limit: 25,
      size: 1,
      _links: { self: '' },
    });

    const body = parse(await handleSearchConfluencePages({ cql: 'x' }));
    expect(body.results[0].url).toBe('/spaces/APA/pages/15106417');
    expect(body.results[0].url).not.toContain('https://');
  });

  it('caches every hit page->instance so a later pageId-only call resolves', async () => {
    searchConfluenceContent.mockResolvedValue({
      results: [hit(), hit({ content: { ...hit().content, id: '999', spaceId: '65602' } })],
      start: 0,
      limit: 25,
      size: 2,
      _links: { self: '' },
    });

    await handleSearchConfluencePages({ cql: 'x' });

    expect(cachePageInstance).toHaveBeenCalledTimes(2);
    expect(cachePageInstance).toHaveBeenNthCalledWith(1, '15106417', '65601', 'onvex');
    expect(cachePageInstance).toHaveBeenNthCalledWith(2, '999', '65602', 'onvex');
  });

  it('skips caching a hit that carries no spaceId', async () => {
    searchConfluenceContent.mockResolvedValue({
      results: [hit({ content: { ...hit().content, spaceId: undefined } })],
      start: 0,
      limit: 25,
      size: 1,
      _links: { self: '' },
    });

    await handleSearchConfluencePages({ cql: 'x' });
    expect(cachePageInstance).not.toHaveBeenCalled();
  });

  it('translates the opaque `cursor` argument into the v1 API `start` offset', async () => {
    searchConfluenceContent.mockResolvedValue({
      results: [],
      start: 25,
      limit: 25,
      size: 0,
      _links: { self: '' },
    });

    await handleSearchConfluencePages({ cql: 'x', limit: 10, cursor: '25' });

    expect(searchConfluenceContent).toHaveBeenCalledWith('x', { limit: 10, start: 25 });
  });

  it('sends no start offset when no cursor is supplied', async () => {
    searchConfluenceContent.mockResolvedValue({
      results: [],
      start: 0,
      limit: 25,
      size: 0,
      _links: { self: '' },
    });

    await handleSearchConfluencePages({ cql: 'x' });

    expect(searchConfluenceContent).toHaveBeenCalledWith('x', {
      limit: undefined,
      start: undefined,
    });
  });

  it('surfaces the next-page cursor from a RELATIVE _links.next', async () => {
    searchConfluenceContent.mockResolvedValue({
      results: [],
      start: 0,
      limit: 25,
      size: 0,
      _links: { self: '', next: '/rest/api/search?cql=x&cursor=abc123&limit=25' },
    });

    const body = parse(await handleSearchConfluencePages({ cql: 'x' }));
    expect(body.cursor).toBe('abc123');
    expect(body.hasMore).toBe(true);
  });

  it('reports hasMore=false and no cursor on the last page', async () => {
    searchConfluenceContent.mockResolvedValue({
      results: [],
      start: 0,
      limit: 25,
      size: 0,
      _links: { self: '' },
    });

    const body = parse(await handleSearchConfluencePages({ cql: 'x' }));
    expect(body.cursor).toBeUndefined();
    expect(body.hasMore).toBe(false);
  });

  it('maps a SEARCH_FAILED ConfluenceError to InvalidRequest, not InternalError', async () => {
    searchConfluenceContent.mockRejectedValue(
      new ConfluenceError('Failed to search content: 400', 'SEARCH_FAILED')
    );

    await expect(handleSearchConfluencePages({ cql: 'bad ~~ cql' })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining('Invalid CQL query'),
    });
  });

  it('maps any other failure to InternalError', async () => {
    searchConfluenceContent.mockRejectedValue(new Error('socket hang up'));

    await expect(handleSearchConfluencePages({ cql: 'x' })).rejects.toBeInstanceOf(McpError);
    await expect(handleSearchConfluencePages({ cql: 'x' })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('Failed to search content: socket hang up'),
    });
  });
});

describe('handleGetConfluenceLabels', () => {
  it('reduces each label to id/name/prefix and echoes pageId + instance', async () => {
    getConfluenceLabels.mockResolvedValue({
      results: [
        {
          id: '1',
          name: 'official',
          prefix: 'global',
          createdAt: '2026-01-01T00:00:00.000Z',
          _links: { self: 'x' },
        },
      ],
    });

    const body = parse(await handleGetConfluenceLabels({ pageId: '15106417' }));

    expect(getConfluenceLabels).toHaveBeenCalledWith('15106417');
    expect(body).toEqual({
      instance: 'onvex',
      pageId: '15106417',
      labels: [{ id: '1', name: 'official', prefix: 'global' }],
    });
  });

  it('returns an empty label list rather than failing on an unlabelled page', async () => {
    getConfluenceLabels.mockResolvedValue({ results: [] });

    const body = parse(await handleGetConfluenceLabels({ pageId: '1' }));
    expect(body.labels).toEqual([]);
  });

  it('maps a client failure to InternalError', async () => {
    getConfluenceLabels.mockRejectedValue(new Error('404 not found'));

    await expect(handleGetConfluenceLabels({ pageId: '1' })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('Failed to get labels: 404 not found'),
    });
  });

  it('maps PAGE_NOT_FOUND to InvalidRequest, as add and remove do', async () => {
    getConfluenceLabels.mockRejectedValue(new ConfluenceError('Page not found', 'PAGE_NOT_FOUND'));

    await expect(handleGetConfluenceLabels({ pageId: '1' })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining('Page not found'),
    });
  });
});

describe('handleAddConfluenceLabel', () => {
  it('adds the label and reports the created label back', async () => {
    addConfluenceLabel.mockResolvedValue({
      id: '7',
      name: 'reviewed',
      prefix: 'global',
      createdAt: '2026-02-02T00:00:00.000Z',
    });

    const body = parse(await handleAddConfluenceLabel({ pageId: '1', label: 'reviewed' }));

    expect(body).toEqual({
      instance: 'onvex',
      message: 'Label added successfully',
      pageId: '1',
      label: {
        id: '7',
        name: 'reviewed',
        prefix: 'global',
        createdAt: '2026-02-02T00:00:00.000Z',
      },
    });
  });

  it("defaults the prefix to 'global' when the caller omits it", async () => {
    addConfluenceLabel.mockResolvedValue({ id: '7', name: 'x', prefix: 'global' });

    await handleAddConfluenceLabel({ pageId: '1', label: 'x' });
    expect(addConfluenceLabel).toHaveBeenCalledWith('1', 'x', 'global');
  });

  it('forwards an explicit prefix', async () => {
    addConfluenceLabel.mockResolvedValue({ id: '7', name: 'x', prefix: 'my' });

    await handleAddConfluenceLabel({ pageId: '1', label: 'x', prefix: 'my' });
    expect(addConfluenceLabel).toHaveBeenCalledWith('1', 'x', 'my');
  });

  it('maps LABEL_EXISTS to InvalidRequest', async () => {
    addConfluenceLabel.mockRejectedValue(
      new ConfluenceError('Label already exists on this page', 'LABEL_EXISTS')
    );

    await expect(handleAddConfluenceLabel({ pageId: '1', label: 'x' })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining('Label already exists'),
    });
  });

  it('maps INVALID_LABEL to InvalidParams', async () => {
    addConfluenceLabel.mockRejectedValue(
      new ConfluenceError('Invalid label format or label already exists', 'INVALID_LABEL')
    );

    await expect(handleAddConfluenceLabel({ pageId: '1', label: '!!' })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('Invalid label format'),
    });
  });

  it('maps PAGE_NOT_FOUND to InvalidRequest, as get and remove do', async () => {
    addConfluenceLabel.mockRejectedValue(new ConfluenceError('Page not found', 'PAGE_NOT_FOUND'));

    await expect(handleAddConfluenceLabel({ pageId: '1', label: 'x' })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining('Page not found'),
    });
  });

  it('maps an unrecognised ConfluenceError code to InternalError', async () => {
    addConfluenceLabel.mockRejectedValue(
      new ConfluenceError('Insufficient permissions to add labels', 'PERMISSION_DENIED')
    );

    await expect(handleAddConfluenceLabel({ pageId: '1', label: 'x' })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('Failed to add label'),
    });
  });

  it('degrades a statusless ConfluenceApiError to InternalError', async () => {
    // The fixtures above are the contract, and `confluence-client.test.ts` now proves the
    // client honours it: a 409 becomes LABEL_EXISTS, a 400 INVALID_LABEL, a 403
    // PERMISSION_DENIED. What still arrives uncoded is a failure that never reached
    // Confluence -- no status, so nothing to map -- and InternalError is the honest answer
    // for it.
    addConfluenceLabel.mockRejectedValue(
      new ConfluenceApiError('Confluence API Error: socket hang up')
    );

    await expect(handleAddConfluenceLabel({ pageId: '1', label: 'x' })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('Failed to add label'),
    });
  });
});

describe('handleRemoveConfluenceLabel', () => {
  it('removes the label and confirms which one', async () => {
    removeConfluenceLabel.mockResolvedValue(undefined);

    const body = parse(await handleRemoveConfluenceLabel({ pageId: '1', label: 'reviewed' }));

    expect(removeConfluenceLabel).toHaveBeenCalledWith('1', 'reviewed');
    expect(body).toEqual({
      instance: 'onvex',
      message: 'Label removed successfully',
      pageId: '1',
      label: 'reviewed',
    });
  });

  it('maps PAGE_NOT_FOUND -- what a 404 now becomes -- to InvalidRequest', async () => {
    // Two stacked defects, both fixed. The client's 404 mapping was unreachable behind
    // `isAxiosError`, AND this handler branched on `LABEL_EXISTS`, which removal never
    // raises. A missing page therefore reached the agent as InternalError with no "not
    // found" signal; `confluence-client.test.ts` now proves a 404 arrives here as
    // PAGE_NOT_FOUND, and this is what the handler makes of it.
    removeConfluenceLabel.mockRejectedValue(
      new ConfluenceError('Page or label not found', 'PAGE_NOT_FOUND')
    );

    await expect(handleRemoveConfluenceLabel({ pageId: '1', label: 'x' })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining('Label not found'),
    });
  });

  it('degrades a statusless ConfluenceApiError to InternalError', async () => {
    removeConfluenceLabel.mockRejectedValue(
      new ConfluenceApiError('Confluence API Error: socket hang up')
    );

    await expect(handleRemoveConfluenceLabel({ pageId: '1', label: 'x' })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('Failed to remove label'),
    });
  });

  it('maps a plain error to InternalError', async () => {
    removeConfluenceLabel.mockRejectedValue(new Error('socket hang up'));

    await expect(handleRemoveConfluenceLabel({ pageId: '1', label: 'x' })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('Failed to remove label: socket hang up'),
    });
  });
});

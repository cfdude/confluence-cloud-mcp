/**
 * Space listing and retrieval (src/handlers/space-handlers.ts).
 *
 * The client and `../src/config.js` are mocked in the style established by
 * `page-write-handlers.test.ts`: without the config mock `getInstanceForSpace` reads
 * `~/.confluence-config.json` and the suite becomes machine-dependent.
 *
 * The assertions worth making here are the SHAPE REDUCTIONS -- these handlers exist to
 * collapse a verbose v2 payload into something an agent can read without burning context,
 * and the cursor is extracted by string-splitting a `_links.next` the API owns.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const getConfluenceSpaces = jest.fn<(options?: unknown) => Promise<any>>();
const getConfluenceSpace = jest.fn<(spaceId: string) => Promise<any>>();

jest.mock('../src/client/confluence-client.js', () => ({
  __esModule: true,
  ConfluenceClient: jest.fn().mockImplementation(() => ({
    getConfluenceSpaces,
    getConfluenceSpace,
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
  cachePageInstance: jest.fn(async () => undefined),
  getInstanceForPageId: jest.fn(async () => null),
}));

import {
  handleGetConfluenceSpace,
  handleListConfluenceSpaces,
} from '../src/handlers/space-handlers.js';

function parse(result: { content: Array<{ type: string; text: string }> }): any {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  return JSON.parse(result.content[0].text);
}

function space(overrides: Record<string, unknown> = {}) {
  return {
    id: '65601',
    key: 'APA',
    name: 'Automation Platform',
    type: 'global',
    status: 'current',
    homepageId: '15106417',
    description: { plain: { value: 'Docs for the platform', representation: 'plain' } },
    icon: { path: '/icon.png', width: 48, height: 48 },
    _links: { webui: '/spaces/APA', self: 'https://example.atlassian.net/wiki/api/v2/spaces/1' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('handleListConfluenceSpaces', () => {
  it('reduces each space to the fields an agent needs and stamps the instance', async () => {
    getConfluenceSpaces.mockResolvedValue({
      results: [space()],
      limit: 25,
      size: 1,
      _links: {},
    });

    const body = parse(await handleListConfluenceSpaces({}));

    expect(body.instance).toBe('onvex');
    expect(body.results).toEqual([
      {
        id: '65601',
        name: 'Automation Platform',
        key: 'APA',
        status: 'current',
        type: 'global',
        description: { value: 'Docs for the platform', representation: 'plain' },
        _links: { webui: '/spaces/APA' },
      },
    ]);
    // `self` and `icon` are deliberately dropped -- context budget, not an oversight.
    expect(body.results[0]).not.toHaveProperty('icon');
    expect(body.results[0]._links).not.toHaveProperty('self');
  });

  it('forwards limit, cursor, sort and status to the client verbatim', async () => {
    getConfluenceSpaces.mockResolvedValue({ results: [], limit: 5, size: 0, _links: {} });

    await handleListConfluenceSpaces({
      limit: 5,
      cursor: 'abc',
      sort: '-name',
      status: 'archived',
    });

    expect(getConfluenceSpaces).toHaveBeenCalledWith({
      limit: 5,
      cursor: 'abc',
      sort: '-name',
      status: 'archived',
    });
  });

  it('reports description as null when the space has none', async () => {
    getConfluenceSpaces.mockResolvedValue({
      results: [space({ description: undefined })],
      limit: 25,
      size: 1,
      _links: {},
    });

    const body = parse(await handleListConfluenceSpaces({}));
    expect(body.results[0].description).toBeNull();
  });

  it('extracts the cursor from _links.next and reports hasMore', async () => {
    getConfluenceSpaces.mockResolvedValue({
      results: [],
      limit: 25,
      size: 0,
      _links: { next: '/wiki/api/v2/spaces?limit=25&cursor=eyJpZCI6NjU2MDF9' },
    });

    const body = parse(await handleListConfluenceSpaces({}));
    expect(body.cursor).toBe('eyJpZCI6NjU2MDF9');
    expect(body.hasMore).toBe(true);
  });

  it('reports no cursor and hasMore=false on the last page', async () => {
    getConfluenceSpaces.mockResolvedValue({ results: [], limit: 25, size: 0, _links: {} });

    const body = parse(await handleListConfluenceSpaces({}));
    expect(body.cursor).toBeUndefined();
    expect(body.hasMore).toBe(false);
  });

  it('swallows a trailing query parameter into the cursor when Confluence appends one', async () => {
    // Documents real behaviour, not desired behaviour: the cursor is taken by splitting on
    // `cursor=` and keeping everything after it, so anything Confluence appends after the
    // cursor value rides along. Today the v2 API puts `cursor` last, so this is latent.
    getConfluenceSpaces.mockResolvedValue({
      results: [],
      limit: 25,
      size: 0,
      _links: { next: '/wiki/api/v2/spaces?cursor=abc123&limit=25' },
    });

    const body = parse(await handleListConfluenceSpaces({}));
    expect(body.cursor).toBe('abc123&limit=25');
  });

  it('raises InternalError when the client fails', async () => {
    getConfluenceSpaces.mockRejectedValue(new Error('Confluence API Error: 500'));

    await expect(handleListConfluenceSpaces({})).rejects.toBeInstanceOf(McpError);
    await expect(handleListConfluenceSpaces({})).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('Failed to list spaces'),
    });
  });
});

describe('handleGetConfluenceSpace', () => {
  it('reduces a single space and stamps the instance', async () => {
    getConfluenceSpace.mockResolvedValue(space());

    const body = parse(await handleGetConfluenceSpace({ spaceId: '65601' }));

    expect(getConfluenceSpace).toHaveBeenCalledWith('65601');
    expect(body).toEqual({
      instance: 'onvex',
      id: '65601',
      name: 'Automation Platform',
      key: 'APA',
      status: 'current',
      type: 'global',
      description: { value: 'Docs for the platform', representation: 'plain' },
      homepage: '15106417',
      url: '/spaces/APA',
    });
  });

  it('reports description as null when the space has none', async () => {
    getConfluenceSpace.mockResolvedValue(space({ description: undefined }));

    const body = parse(await handleGetConfluenceSpace({ spaceId: '65601' }));
    expect(body.description).toBeNull();
  });

  it('rejects a missing spaceId with InvalidParams and never calls the client', async () => {
    await expect(handleGetConfluenceSpace({ spaceId: '' })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('spaceId is required'),
    });
    expect(getConfluenceSpace).not.toHaveBeenCalled();
  });

  it('re-raises an McpError from the client without re-wrapping it', async () => {
    getConfluenceSpace.mockRejectedValue(new McpError(ErrorCode.InvalidRequest, 'no such space'));

    await expect(handleGetConfluenceSpace({ spaceId: '9' })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining('no such space'),
    });
  });

  it('wraps a plain client error as InternalError', async () => {
    getConfluenceSpace.mockRejectedValue(new Error('socket hang up'));

    await expect(handleGetConfluenceSpace({ spaceId: '9' })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('Failed to get space: socket hang up'),
    });
  });
});

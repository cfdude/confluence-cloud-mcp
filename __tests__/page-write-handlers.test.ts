import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * Handler-level write safety (spec: page-write-safety).
 *
 * These assertions cannot be made against pure functions: the point of most of them is that a
 * MODIFYING REQUEST WAS NEVER SENT (task 5.16), which is a statement about the client, and
 * that the title and version submitted are the server's, not the caller's (tasks 5.1, 5.2).
 *
 * `../src/config.js` is mocked as well as the client -- without it `getInstanceForSpace` reads
 * `~/.confluence-config.json` and the suite becomes machine-dependent.
 */

const getConfluencePage = jest.fn<(pageId: string) => Promise<unknown>>();
const updateConfluencePage =
  jest.fn<(pageId: string, title: string, content: string, version: number) => Promise<unknown>>();
const createConfluencePage =
  jest.fn<
    (spaceId: string, title: string, content: string, parentId?: string) => Promise<unknown>
  >();
const addConfluenceLabel = jest.fn();

jest.mock('../src/client/confluence-client.js', () => ({
  __esModule: true,
  ConfluenceClient: jest.fn().mockImplementation(() => ({
    getConfluencePage,
    updateConfluencePage,
    createConfluencePage,
    addConfluenceLabel,
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
  handleCreateConfluencePage,
  handleUpdateConfluencePage,
} from '../src/handlers/page-handlers.js';
import { ConfluenceApiError } from '../src/types/index.js';
import { versionConflictError } from '../src/utils/write-safety.js';

const MACRO_PAGE =
  '<p>Intro</p><ac:structured-macro ac:name="toc"><ac:parameter ac:name="minLevel">2' +
  '</ac:parameter></ac:structured-macro><p>Outro</p>';

/**
 * A page as the LIVE v2 API returns it.
 *
 * `status` is the flat string, not `{ value }`. The `Page` interface declares the object form
 * and is wrong; that is pre-existing and out of scope here, but the fixture must not model a
 * shape the API never produces.
 */
function page(overrides: { version?: number; title?: string; storage?: string } = {}) {
  return {
    id: '123456',
    status: 'current',
    title: overrides.title ?? 'Quarterly Plan',
    spaceId: '789',
    parentId: '654321',
    authorId: 'author-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    version: {
      number: overrides.version ?? 7,
      createdAt: '2026-02-02T00:00:00.000Z',
      authorId: 'author-1',
      minorEdit: false,
    },
    body: {
      storage: { value: overrides.storage ?? '<p>Existing body</p>', representation: 'storage' },
    },
    _links: {
      webui: '/spaces/APA/pages/123456',
      editui: '/pages/resumedraft.action?draftId=123456',
      tinyui: '/x/abc',
    },
  };
}

/** What the handler returns, parsed back out of its JSON text block. */
function payload(result: unknown): Record<string, unknown> {
  const text = (result as { content: { text: string }[] }).content[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

/** Every request that could modify a page. Task 5.16 asserts none of these fired. */
function expectNoModifyingRequest(): void {
  expect(updateConfluencePage).not.toHaveBeenCalled();
  expect(createConfluencePage).not.toHaveBeenCalled();
  expect(addConfluenceLabel).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  getConfluencePage.mockResolvedValue(page());
  updateConfluencePage.mockImplementation(async (_pageId, title, _content, version) =>
    page({ title, version })
  );
  createConfluencePage.mockResolvedValue(page({ version: 1 }));
});

// ---------------------------------------------------------------------------
// 5.1 -- title is optional and preserved
// ---------------------------------------------------------------------------

describe('title is optional and preserved (task 5.1)', () => {
  it('keeps the current title when none is supplied, and updates the content', async () => {
    const result = await handleUpdateConfluencePage({
      pageId: '123456',
      content: '<p>Fresh body</p>',
    });

    expect(updateConfluencePage).toHaveBeenCalledWith(
      '123456',
      'Quarterly Plan',
      '<p>Fresh body</p>',
      8
    );
    expect(payload(result).title).toBe('Quarterly Plan');
  });

  it('applies a supplied title that differs', async () => {
    await handleUpdateConfluencePage({
      pageId: '123456',
      title: 'Quarterly Plan (2026)',
      content: '<p>Fresh body</p>',
    });

    expect(updateConfluencePage).toHaveBeenCalledWith(
      '123456',
      'Quarterly Plan (2026)',
      '<p>Fresh body</p>',
      8
    );
  });

  it('treats an unchanged title as an ordinary update, not a rename', async () => {
    const result = await handleUpdateConfluencePage({
      pageId: '123456',
      title: 'Quarterly Plan',
      content: '<p>Fresh body</p>',
    });

    expect(payload(result).title).toBe('Quarterly Plan');
    expect(payload(result).message).toBe('Page updated successfully');
  });
});

// ---------------------------------------------------------------------------
// 5.2 -- the server resolves the version
// ---------------------------------------------------------------------------

describe('the server resolves the write version (task 5.2, design.md D5)', () => {
  it('writes version 8 for a page at version 7, with no version from the caller', async () => {
    await handleUpdateConfluencePage({ pageId: '123456', content: '<p>Fresh body</p>' });

    expect(updateConfluencePage.mock.calls[0][3]).toBe(8);
  });

  it('IGNORES a version supplied by a legacy caller rather than forwarding it', async () => {
    // An old caller was told to send `current + 1`. Forwarding that verbatim is the off-by-one
    // this change removes; mapping it onto expectedVersion would be a spurious conflict.
    await handleUpdateConfluencePage({
      pageId: '123456',
      title: 'Quarterly Plan',
      content: '<p>Fresh body</p>',
      version: 8,
    });

    expect(updateConfluencePage.mock.calls[0][3]).toBe(8);

    jest.clearAllMocks();
    getConfluencePage.mockResolvedValue(page({ version: 41 }));
    updateConfluencePage.mockResolvedValue(page({ version: 42 }));

    await handleUpdateConfluencePage({
      pageId: '123456',
      content: '<p>Fresh body</p>',
      version: 3,
    });

    expect(updateConfluencePage.mock.calls[0][3]).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 5.3 -- optimistic concurrency
// ---------------------------------------------------------------------------

describe('expectedVersion conflict detection (task 5.3)', () => {
  it('proceeds when the expectation matches the current version', async () => {
    await handleUpdateConfluencePage({
      pageId: '123456',
      content: '<p>Fresh body</p>',
      expectedVersion: 7,
    });

    expect(updateConfluencePage).toHaveBeenCalled();
  });

  it('fails on a stale expectation, reporting both versions and writing nothing', async () => {
    getConfluencePage.mockResolvedValue(page({ version: 9 }));

    await expect(
      handleUpdateConfluencePage({
        pageId: '123456',
        content: '<p>Fresh body</p>',
        expectedVersion: 7,
      })
    ).rejects.toThrow(/expected version 7 but the page is at version 9/);

    expectNoModifyingRequest();
  });

  it('still fails on a stale expectation when construct-removal is confirmed', async () => {
    // confirmConstructRemoval short-circuits the construct-loss check, which is where the
    // current page is otherwise resolved -- the version check must not go with it.
    getConfluencePage.mockResolvedValue(page({ version: 9 }));

    await expect(
      handleUpdateConfluencePage({
        pageId: '123456',
        content: '<p>Fresh body</p>',
        expectedVersion: 7,
        confirmConstructRemoval: true,
      })
    ).rejects.toThrow(/expected version 7 but the page is at version 9/);

    expectNoModifyingRequest();
  });

  it('skips the check when no expectation is supplied', async () => {
    getConfluencePage.mockResolvedValue(page({ version: 9 }));

    await handleUpdateConfluencePage({ pageId: '123456', content: '<p>Fresh body</p>' });

    expect(updateConfluencePage.mock.calls[0][3]).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 5.15 -- Confluence's own rejection normalizes to the same shape
// ---------------------------------------------------------------------------

describe('conflicts report identically however detected (task 5.15, design.md D12)', () => {
  it('normalizes a 409 from Confluence into the local conflict error', async () => {
    getConfluencePage
      .mockResolvedValueOnce(page({ version: 7 })) // resolution, before the write
      .mockResolvedValueOnce(page({ version: 9 })); // re-read, after the rejection
    updateConfluencePage.mockRejectedValue(
      new ConfluenceApiError('Confluence API Error: Version conflict', 409)
    );

    let error: unknown;
    try {
      await handleUpdateConfluencePage({ pageId: '123456', content: '<p>Fresh body</p>' });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).message).toBe(
      versionConflictError({ expectedVersion: 7, currentVersion: 9 }).message
    );
  });

  it('keeps the conflict shape when the current version cannot be re-read', async () => {
    getConfluencePage
      .mockResolvedValueOnce(page({ version: 7 }))
      .mockRejectedValueOnce(new Error('network down'));
    updateConfluencePage.mockRejectedValue(
      new ConfluenceApiError('Confluence API Error: Version must be incremented', 400)
    );

    await expect(
      handleUpdateConfluencePage({ pageId: '123456', content: '<p>Fresh body</p>' })
    ).rejects.toThrow(/Version conflict: this write expected version 7/);
  });

  it('does NOT report a conflict when the re-read shows the version did not move', async () => {
    // Confluence answers 409 for a duplicate title too, and `title` is still a supported
    // parameter. An unchanged version disproves the conflict, so the caller must get
    // Confluence's own message rather than "expected version 7 but the page is at version 7".
    getConfluencePage
      .mockResolvedValueOnce(page({ version: 7 }))
      .mockResolvedValueOnce(page({ version: 7 }));
    updateConfluencePage.mockRejectedValue(
      new ConfluenceApiError(
        'Confluence API Error: A page with this title already exists in this space',
        409
      )
    );

    await expect(
      handleUpdateConfluencePage({
        pageId: '123456',
        title: 'Already Taken',
        content: '<p>Fresh body</p>',
      })
    ).rejects.toThrow(/Failed to update page.*already exists in this space/);
  });

  it('does not disguise an unrelated API failure as a conflict', async () => {
    updateConfluencePage.mockRejectedValue(
      new ConfluenceApiError('Confluence API Error: Insufficient permissions', 403)
    );

    await expect(
      handleUpdateConfluencePage({ pageId: '123456', content: '<p>Fresh body</p>' })
    ).rejects.toThrow(/Failed to update page/);
  });
});

// ---------------------------------------------------------------------------
// 5.16 -- every rejected path leaves the page unmodified
// ---------------------------------------------------------------------------

describe('rejected updates send no modifying request (task 5.16)', () => {
  it.each([
    ['malformed storage', { content: '<p>unclosed' }, /not well-formed/],
    ['markdown', { content: '<p>## Summary</p>' }, /appears to be markdown/],
    [
      'a macro placeholder',
      { content: '<p>[Confluence Macro: toc (minLevel: 2)]</p>' },
      /rendered macro placeholder/,
    ],
    ['a $1 artifact', { content: '<p>1. $1  2. $1</p>' }, /markdown-conversion artifact/],
  ])('rejects %s locally with no request at all', async (_label, args, expected) => {
    await expect(
      handleUpdateConfluencePage({ pageId: '123456', ...(args as { content: string }) })
    ).rejects.toThrow(expected);

    expectNoModifyingRequest();
    expect(getConfluencePage).not.toHaveBeenCalled();
  });

  it('rejects a construct-dropping submission after reading, but before writing', async () => {
    getConfluencePage.mockResolvedValue(page({ storage: MACRO_PAGE }));

    await expect(
      handleUpdateConfluencePage({ pageId: '123456', content: '<p>Intro</p><p>Outro</p>' })
    ).rejects.toThrow(/macro "toc"/);

    expect(getConfluencePage).toHaveBeenCalled();
    expectNoModifyingRequest();
  });

  it('proceeds once the removal is confirmed', async () => {
    getConfluencePage.mockResolvedValue(page({ storage: MACRO_PAGE }));

    await handleUpdateConfluencePage({
      pageId: '123456',
      content: '<p>Intro</p><p>Outro</p>',
      confirmConstructRemoval: true,
    });

    expect(updateConfluencePage).toHaveBeenCalled();
  });

  it('proceeds once markdown is explicitly allowed', async () => {
    await handleUpdateConfluencePage({
      pageId: '123456',
      content: '<p>Use ## for a level-two heading</p>',
      allowMarkdownContent: true,
    });

    expect(updateConfluencePage).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5.14 -- page creation is subject to the content checks
// ---------------------------------------------------------------------------

describe('create_confluence_page content checks (task 5.14, design.md D11)', () => {
  const base = { spaceId: '789', title: 'TEST: New Page' };

  it.each([
    ['markdown', '## Executive Summary\n\n- a point\n', /appears to be markdown/],
    ['a $1 artifact', '<p>1. $1  2. $1</p>', /markdown-conversion artifact/],
    ['malformed storage', '<p>unclosed', /not well-formed/],
    ['a macro placeholder', '<p>[Confluence Macro: toc]</p>', /rendered macro placeholder/],
  ])('rejects a create carrying %s, and creates no page', async (_label, content, expected) => {
    await expect(handleCreateConfluencePage({ ...base, content })).rejects.toThrow(expected);

    expectNoModifyingRequest();
  });

  it('creates a page from well-formed storage', async () => {
    const result = await handleCreateConfluencePage({
      ...base,
      content: '<h2>Overview</h2><p>Body</p>',
    });

    expect(createConfluencePage).toHaveBeenCalledWith(
      '789',
      'TEST: New Page',
      '<h2>Overview</h2><p>Body</p>',
      undefined
    );
    expect(payload(result).message).toBe('Page created successfully');
  });

  it('applies no construct-loss check -- a create has nothing to compare against', async () => {
    await handleCreateConfluencePage({ ...base, content: '<p>No macros here</p>' });

    expect(createConfluencePage).toHaveBeenCalled();
    expect(getConfluencePage).not.toHaveBeenCalled();
  });

  it('honours the markdown override on create too', async () => {
    await handleCreateConfluencePage({
      ...base,
      content: '<p>Use ## for a level-two heading</p>',
      allowMarkdownContent: true,
    });

    expect(createConfluencePage).toHaveBeenCalled();
  });
});

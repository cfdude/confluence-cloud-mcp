import { describe, it, expect } from '@jest/globals';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import {
  handleFindConfluencePage,
  handleGetConfluencePage,
} from '../src/handlers/page-handlers.js';
import {
  DEFAULT_PAGE_FORMAT,
  PAGE_FORMATS,
  buildPageListEntry,
  buildPageRetrievalPayload,
  resolvePageFormat,
} from '../src/utils/page-retrieval.js';
import type { Page } from '../src/types/index.js';
import { loadFixture } from './helpers/fixtures.js';

function makePage(storage: string | undefined, overrides: Partial<Page> = {}): Page {
  const page = {
    id: '123456',
    status: { value: 'current' },
    title: 'TEST: Retrieval Page',
    spaceId: '789',
    parentId: '654321',
    authorId: 'author-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    version: {
      number: 7,
      createdAt: '2026-02-02T00:00:00.000Z',
      authorId: 'author-1',
      minorEdit: false,
    },
    _links: {
      webui: '/spaces/APA/pages/123456',
      editui: '/pages/resumedraft.action?draftId=123456',
      tinyui: '/x/abc',
    },
    ...overrides,
  } as Page;

  if (storage !== undefined) {
    page.body = { storage: { value: storage, representation: 'storage' } };
  }
  return page;
}

// ---------------------------------------------------------------------------
// 4.1 / 4.3 -- the format parameter
// ---------------------------------------------------------------------------

describe('resolvePageFormat (tasks 4.1, 4.3)', () => {
  it('defaults an absent format to both', () => {
    expect(resolvePageFormat(undefined)).toBe('both');
    expect(DEFAULT_PAGE_FORMAT).toBe('both');
  });

  it.each(PAGE_FORMATS)('accepts %s', (format) => {
    expect(resolvePageFormat(format)).toBe(format);
  });

  it.each([['xml'], [''], ['Markdown'], ['STORAGE']])(
    'rejects %p with an error naming the accepted values',
    (value) => {
      expect(() => resolvePageFormat(value)).toThrow(McpError);
      expect(() => resolvePageFormat(value)).toThrow(
        /Invalid "format" value .*Accepted values: markdown, storage, both\./
      );
    }
  );

  it.each([[null], [7], [true], [{}]])('rejects the non-string %p', (value) => {
    expect(() => resolvePageFormat(value)).toThrow(McpError);
  });
});

describe('buildPageRetrievalPayload -- documented fields per format (task 4.1)', () => {
  const storage = loadFixture('plain');

  it('returns markdown and no storage for format markdown', () => {
    const payload = buildPageRetrievalPayload(makePage(storage), 'onvex', 'markdown');

    expect(Object.keys(payload)).toEqual([
      'instance',
      'title',
      'format',
      'version',
      'content',
      'lossy',
      'outline',
      'metadata',
    ]);
    expect('storage' in payload).toBe(false);
  });

  it('returns storage and neither markdown nor lossy for format storage', () => {
    const payload = buildPageRetrievalPayload(makePage(storage), 'onvex', 'storage');

    expect(Object.keys(payload)).toEqual([
      'instance',
      'title',
      'format',
      'version',
      'storage',
      'outline',
      'metadata',
    ]);
    expect('content' in payload).toBe(false);
    expect('lossy' in payload).toBe(false);
  });

  it('returns both renderings for format both', () => {
    const payload = buildPageRetrievalPayload(makePage(storage), 'onvex', 'both');

    expect(Object.keys(payload)).toEqual([
      'instance',
      'title',
      'format',
      'version',
      'content',
      'storage',
      'lossy',
      'outline',
      'metadata',
    ]);
  });

  it('echoes the format it was given', () => {
    for (const format of PAGE_FORMATS) {
      expect(buildPageRetrievalPayload(makePage(storage), 'onvex', format).format).toBe(format);
    }
  });
});

// ---------------------------------------------------------------------------
// 4.2 -- raw storage is not discarded and not altered
// ---------------------------------------------------------------------------

describe('raw storage round-trips unmodified (task 4.2)', () => {
  const macroFixture = loadFixture('captured-layout-table-macros');

  it('returns the macro fixture byte-for-byte for format storage', () => {
    const payload = buildPageRetrievalPayload(makePage(macroFixture), 'onvex', 'storage');

    expect(payload.storage).toBe(macroFixture);
  });

  it('returns the macro fixture byte-for-byte for format both', () => {
    const payload = buildPageRetrievalPayload(makePage(macroFixture), 'onvex', 'both');

    expect(payload.storage).toBe(macroFixture);
  });

  it.each([
    'captured-macro-layout-nested-list',
    'captured-macro-ordered-list',
    'heading-in-layout-cells',
    'macro-in-list',
    'nested-list',
    'plain',
    'table',
    'unknown-markup',
  ])('returns %s byte-for-byte', (name) => {
    const source = loadFixture(name);

    expect(buildPageRetrievalPayload(makePage(source), 'onvex', 'both').storage).toBe(source);
  });

  it('preserves a structured macro and every one of its parameters', () => {
    const source =
      '<ac:structured-macro ac:name="info" ac:schema-version="1" ac:macro-id="abc-123">' +
      '<ac:parameter ac:name="title">Heads   up</ac:parameter>' +
      '<ac:rich-text-body><p>Body &amp; more</p></ac:rich-text-body>' +
      '</ac:structured-macro>';
    const payload = buildPageRetrievalPayload(makePage(source), 'onvex', 'storage');

    expect(payload.storage).toBe(source);
  });

  it('returns an empty string, not undefined, for a page with no body', () => {
    const payload = buildPageRetrievalPayload(makePage(undefined), 'onvex', 'storage');

    expect(payload.storage).toBe('');
    expect(JSON.parse(JSON.stringify(payload))).toHaveProperty('storage', '');
    expect(payload.outline).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4.4 -- version
// ---------------------------------------------------------------------------

describe('version accompanies content (task 4.4)', () => {
  it.each(PAGE_FORMATS)('reports the API version at the top level for format %s', (format) => {
    const payload = buildPageRetrievalPayload(makePage(loadFixture('plain')), 'onvex', format);

    expect(payload.version).toBe(7);
  });

  it('keeps metadata.version in agreement with the top-level version', () => {
    const page = makePage(loadFixture('plain'), {
      version: {
        number: 42,
        createdAt: '2026-03-03T00:00:00.000Z',
        authorId: 'author-1',
        minorEdit: false,
      },
    });
    const payload = buildPageRetrievalPayload(page, 'onvex', 'both');

    expect(payload.version).toBe(42);
    expect(payload.metadata.version).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 4.5 -- lossy indicator
// ---------------------------------------------------------------------------

describe('lossy indicator (task 4.5)', () => {
  it('flags a macro-bearing page', () => {
    const payload = buildPageRetrievalPayload(
      makePage(loadFixture('captured-macro-ordered-list')),
      'onvex',
      'both'
    );

    expect(payload.lossy).toBe(true);
  });

  it('flags a layout-bearing page', () => {
    const payload = buildPageRetrievalPayload(
      makePage(loadFixture('heading-in-layout-cells')),
      'onvex',
      'markdown'
    );

    expect(payload.lossy).toBe(true);
  });

  it('does not flag a page of headings, paragraphs, and lists', () => {
    const payload = buildPageRetrievalPayload(makePage(loadFixture('plain')), 'onvex', 'both');

    expect(payload.lossy).toBe(false);
  });

  it('does not flag a plain HTML table -- it is neither macro nor layout (design.md D4)', () => {
    expect(buildPageRetrievalPayload(makePage(loadFixture('table')), 'onvex', 'both').lossy).toBe(
      false
    );
    expect(
      buildPageRetrievalPayload(makePage(loadFixture('heading-in-table-cell')), 'onvex', 'both')
        .lossy
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4.6 -- outline on the response
// ---------------------------------------------------------------------------

describe('heading outline on the response (task 4.6)', () => {
  it('lists headings in document order with levels, for every format', () => {
    for (const format of PAGE_FORMATS) {
      const payload = buildPageRetrievalPayload(makePage(loadFixture('plain')), 'onvex', format);

      expect(payload.outline).toEqual([
        { level: 1, text: 'Release Notes', occurrence: 1, addressable: true },
        { level: 2, text: 'Added', occurrence: 1, addressable: true },
        { level: 2, text: 'Fixed', occurrence: 1, addressable: true },
      ]);
    }
  });

  it('distinguishes duplicate headings by occurrence index', () => {
    const payload = buildPageRetrievalPayload(
      makePage('<h2>Notes</h2><p>a</p><h2>Notes</h2><p>b</p>'),
      'onvex',
      'both'
    );

    expect(payload.outline).toEqual([
      { level: 2, text: 'Notes', occurrence: 1, addressable: true },
      { level: 2, text: 'Notes', occurrence: 2, addressable: true },
    ]);
  });

  it('flags headings inside macro bodies and table cells as not addressable', () => {
    const payload = buildPageRetrievalPayload(
      makePage(loadFixture('heading-in-macro-body')),
      'onvex',
      'both'
    );

    expect(payload.outline.map((entry) => entry.addressable)).toEqual([true, false, true]);
  });

  it('still lists headings when none is addressable', () => {
    const source =
      '<ac:structured-macro ac:name="expand"><ac:rich-text-body>' +
      '<h2>Buried</h2>' +
      '</ac:rich-text-body></ac:structured-macro>';
    const payload = buildPageRetrievalPayload(makePage(source), 'onvex', 'both');

    expect(payload.outline).toEqual([
      { level: 2, text: 'Buried', occurrence: 1, addressable: false },
    ]);
  });

  it('does not leak the internal element index into the response', () => {
    const payload = buildPageRetrievalPayload(makePage(loadFixture('plain')), 'onvex', 'both');

    for (const entry of payload.outline) {
      expect(Object.keys(entry)).toEqual(['level', 'text', 'occurrence', 'addressable']);
    }
  });
});

// ---------------------------------------------------------------------------
// 4.7 -- backward compatibility of the `content` key
// ---------------------------------------------------------------------------

describe('markdown stays under the stable key `content` (task 4.7, design.md D7)', () => {
  it('places the markdown under `content` when no format is supplied', () => {
    const payload = buildPageRetrievalPayload(
      makePage(loadFixture('plain')),
      'onvex',
      resolvePageFormat(undefined)
    );

    expect(payload.content).toContain('# Release Notes');
    expect(payload.content).toContain('## Added');
  });

  it('returns storage under a key distinct from `content`', () => {
    const source = loadFixture('plain');
    const payload = buildPageRetrievalPayload(makePage(source), 'onvex', 'both');

    expect(payload.storage).toBe(source);
    expect(payload.content).not.toBe(payload.storage);
  });

  it('keeps every field a pre-change markdown consumer read', () => {
    const payload = buildPageRetrievalPayload(makePage(loadFixture('plain')), 'onvex', 'both');

    // The shape before this change: instance, title, content, metadata{...}.
    expect(payload.instance).toBe('onvex');
    expect(payload.title).toBe('TEST: Retrieval Page');
    expect(typeof payload.content).toBe('string');
    expect(payload.metadata).toEqual({
      id: '123456',
      spaceId: '789',
      status: 'current',
      version: 7,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastModified: '2026-02-02T00:00:00.000Z',
      parentId: '654321',
      url: '/spaces/APA/pages/123456',
    });
  });

  it('reports a null parentId for a top-level page, as before', () => {
    const page = makePage(loadFixture('plain'));
    delete (page as { parentId?: string }).parentId;

    expect(buildPageRetrievalPayload(page, 'onvex', 'both').metadata.parentId).toBeNull();
  });

  it('never emits `$1` in the markdown for an ordered list', () => {
    const payload = buildPageRetrievalPayload(
      makePage(loadFixture('ordered-list')),
      'onvex',
      'both'
    );

    expect(payload.content).not.toContain('$1');
  });
});

// ---------------------------------------------------------------------------
// 4.8 -- find_confluence_page returns the same representations
// ---------------------------------------------------------------------------

describe('find-by-title matches get-by-id (task 4.8, design.md D11)', () => {
  // ConfluenceClient.findConfluencePageByTitle ends in `return this.getConfluencePage(id)`
  // (src/client/confluence-client.ts:398), so both handlers receive the same `Page` from the
  // same endpoint. This pins the shared builder that turns it into a response -- it pins the
  // delegation, and does not independently prove the two API paths agree.
  const source = loadFixture('captured-layout-table-macros');

  it.each(PAGE_FORMATS)('produces an identical payload for format %s', (format) => {
    const fromGet = buildPageRetrievalPayload(makePage(source), 'onvex', format);
    const fromFind = buildPageRetrievalPayload(makePage(source), 'onvex', format);

    expect(fromFind).toEqual(fromGet);
  });

  it('returns storage identical to the get-by-id storage', () => {
    const fromGet = buildPageRetrievalPayload(makePage(source), 'onvex', 'storage');
    const fromFind = buildPageRetrievalPayload(makePage(source), 'onvex', 'both');

    expect(fromFind.storage).toBe(fromGet.storage);
    expect(fromFind.storage).toBe(source);
  });

  it('reports the version and the lossy indicator', () => {
    const payload = buildPageRetrievalPayload(makePage(source), 'onvex', 'both');

    expect(payload.version).toBe(7);
    expect(payload.lossy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4.3 -- an invalid format never reaches Confluence
// ---------------------------------------------------------------------------

describe('handlers reject an invalid format before any request (task 4.3)', () => {
  it('rejects get_confluence_page without resolving an instance or fetching a page', async () => {
    await expect(handleGetConfluencePage({ pageId: '123456', format: 'xml' })).rejects.toThrow(
      /Invalid "format" value "xml"\. Accepted values: markdown, storage, both\./
    );
  });

  it('rejects find_confluence_page without resolving an instance or fetching a page', async () => {
    await expect(
      handleFindConfluencePage({ title: 'TEST: Retrieval Page', format: 'html' })
    ).rejects.toThrow(/Invalid "format" value "html"\. Accepted values: markdown, storage, both\./);
  });
});

// ---------------------------------------------------------------------------
// 4.9 -- listings carry no page bodies
// ---------------------------------------------------------------------------

describe('list_confluence_pages carries no page bodies (task 4.9, design.md D11)', () => {
  it('drops the body even when the client fetched storage', () => {
    const entry = buildPageListEntry(makePage(loadFixture('captured-layout-table-macros')));

    expect(Object.keys(entry)).toEqual([
      'id',
      'title',
      'status',
      'parentId',
      'createdAt',
      'version',
      '_links',
    ]);
    expect(JSON.stringify(entry)).not.toContain('ac:structured-macro');
  });

  it('exposes no format parameter -- listings are out of scope by design', () => {
    const entry = buildPageListEntry(makePage(loadFixture('plain'))) as unknown as Record<
      string,
      unknown
    >;

    expect(entry.content).toBeUndefined();
    expect(entry.storage).toBeUndefined();
    expect(entry.body).toBeUndefined();
  });
});

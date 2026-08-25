/**
 * Handler-level section editing (spec: page-section-editing; design.md D6, D9, D12).
 *
 * These assertions cannot be made against the pure resolver: their point is that NO MODIFYING
 * REQUEST WAS SENT, that the title and version submitted are the server's rather than the
 * caller's, and that construct-loss is scoped to the replaced SPAN rather than the whole page.
 *
 * `../src/config.js` is mocked alongside the client -- without it `getInstanceForSpace` reads
 * `~/.confluence-config.json` and the suite becomes machine-dependent.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

const getConfluencePage = jest.fn<(pageId: string) => Promise<unknown>>();
const updateConfluencePage =
  jest.fn<(pageId: string, title: string, content: string, version: number) => Promise<unknown>>();

jest.mock('../src/client/confluence-client.js', () => ({
  __esModule: true,
  ConfluenceClient: jest.fn().mockImplementation(() => ({
    getConfluencePage,
    updateConfluencePage,
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
  handleAppendConfluenceSection,
  handleInsertConfluenceSection,
  handleReplaceConfluenceSection,
} from '../src/handlers/section-handlers.js';
import { ConfluenceApiError } from '../src/types/index.js';

const INFO_MACRO =
  '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>note</p></ac:rich-text-body>' +
  '</ac:structured-macro>';
const TOC_MACRO = '<ac:structured-macro ac:name="toc"></ac:structured-macro>';

/**
 * Three sections. `Details` carries a macro INSIDE its span; `Outro` carries a different macro
 * OUTSIDE it. That is what makes span-scoping observable rather than assumed.
 */
const SECTION_PAGE =
  '<h2>Intro</h2><p>intro body</p>' +
  `<h2>Details</h2><p>detail body</p>${INFO_MACRO}` +
  `<h2>Outro</h2>${TOC_MACRO}<p>outro body</p>`;

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
      storage: { value: overrides.storage ?? SECTION_PAGE, representation: 'storage' },
    },
    _links: {
      webui: '/spaces/APA/pages/123456',
      editui: '/pages/resumedraft.action?draftId=123456',
      tinyui: '/x/abc',
    },
  };
}

function payload(result: unknown): Record<string, unknown> {
  const text = (result as { content: { text: string }[] }).content[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

/** The content the handler actually submitted. */
function submitted(): string {
  expect(updateConfluencePage).toHaveBeenCalledTimes(1);
  return updateConfluencePage.mock.calls[0][2];
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    return (error as McpError).message;
  }
  throw new Error('expected the section edit to be rejected');
}

beforeEach(() => {
  jest.clearAllMocks();
  getConfluencePage.mockResolvedValue(page());
  updateConfluencePage.mockImplementation(async (_pageId, title, _content, version) =>
    page({ title, version })
  );
});

describe('expectedVersion is REQUIRED on section edits (task 6.9, design.md D9)', () => {
  it('rejects a request that omits it, without reading or writing anything', async () => {
    const message = await failure(() =>
      handleReplaceConfluenceSection({
        pageId: '123456',
        heading: 'Intro',
        content: '<p>new</p>',
      })
    );

    expect(message).toContain('requires "expectedVersion"');
    expect(getConfluencePage).not.toHaveBeenCalled();
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });

  it('rejects a non-integer value rather than turning it into a spurious conflict', async () => {
    for (const value of ['7', 7.5, 0, null]) {
      const message = await failure(() =>
        handleReplaceConfluenceSection({
          pageId: '123456',
          heading: 'Intro',
          content: '<p>new</p>',
          expectedVersion: value as never,
        })
      );
      expect(message).toContain('requires "expectedVersion"');
    }
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });

  it('requires it on append and insert as well', async () => {
    expect(
      await failure(() =>
        handleAppendConfluenceSection({ pageId: '1', heading: 'Intro', content: '<p>x</p>' })
      )
    ).toContain('expectedVersion');
    expect(
      await failure(() =>
        handleInsertConfluenceSection({ pageId: '1', heading: 'Intro', newHeading: 'New' })
      )
    ).toContain('expectedVersion');
  });

  it('fails a stale value before any splice is attempted', async () => {
    const message = await failure(() =>
      handleReplaceConfluenceSection({
        pageId: '123456',
        heading: 'Intro',
        content: '<p>new</p>',
        expectedVersion: 6,
      })
    );

    expect(message).toContain('Version conflict');
    expect(message).toContain('expected version 6');
    expect(message).toContain('version 7');
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });
});

describe('content is REQUIRED on replace and append (Gate 2 finding)', () => {
  // Regression test. Omitting `content` was treated as an empty body, so `replace` spliced the
  // section's body out and reported success while `append` became a silent no-op. Reproduced
  // against live Confluence before the fix: a two-paragraph section was reduced to its heading
  // alone, with no error returned. Nothing enforces a schema's `required` array at runtime, so
  // a dropped field must be rejected here or not at all.
  it('rejects replace with content omitted, writing nothing', async () => {
    const message = await failure(() =>
      handleReplaceConfluenceSection({
        pageId: '123456',
        heading: 'Intro',
        expectedVersion: 7,
      } as never)
    );

    expect(message).toContain('content');
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });

  it('rejects append with content omitted, writing nothing', async () => {
    const message = await failure(() =>
      handleAppendConfluenceSection({
        pageId: '123456',
        heading: 'Intro',
        expectedVersion: 7,
      } as never)
    );

    expect(message).toContain('content');
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });

  it('still allows insert to create a section with an empty body', async () => {
    await handleInsertConfluenceSection({
      pageId: '123456',
      heading: 'Intro',
      newHeading: 'Empty Section',
      expectedVersion: 7,
    });

    expect(updateConfluencePage).toHaveBeenCalled();
  });
});

describe('the shared write-safety contract applies (task 6.10)', () => {
  it('preserves the title and resolves the version server-side', async () => {
    const result = await handleReplaceConfluenceSection({
      pageId: '123456',
      heading: 'Intro',
      content: '<p>rewritten</p>',
      expectedVersion: 7,
    });

    expect(updateConfluencePage).toHaveBeenCalledWith(
      '123456',
      'Quarterly Plan',
      SECTION_PAGE.replace('<p>intro body</p>', '<p>rewritten</p>'),
      8
    );
    expect(payload(result).title).toBe('Quarterly Plan');
    expect(payload(result).version).toBe(8);
  });

  it('rejects markdown supplied as section content, with the corrective message', async () => {
    const message = await failure(() =>
      handleReplaceConfluenceSection({
        pageId: '123456',
        heading: 'Intro',
        content: '## Overview\n\nSome **bold** prose.',
        expectedVersion: 7,
      })
    );

    expect(message).toContain('appears to be markdown');
    expect(message).toContain("format: 'storage'");
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });

  it('rejects malformed section content before the write (task 6.8)', async () => {
    const message = await failure(() =>
      handleReplaceConfluenceSection({
        pageId: '123456',
        heading: 'Intro',
        content: '<p>unclosed',
        expectedVersion: 7,
      })
    );

    expect(message).toContain('not well-formed');
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });

  it('rejects the conversion artifact in section content', async () => {
    const message = await failure(() =>
      handleReplaceConfluenceSection({
        pageId: '123456',
        heading: 'Intro',
        content: '<p>1. $1  2. $1</p>',
        expectedVersion: 7,
      })
    );

    expect(message).toContain('markdown-conversion artifact');
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });

  it('reports markdown rather than construct loss when both apply (design.md D10)', async () => {
    const message = await failure(() =>
      handleReplaceConfluenceSection({
        pageId: '123456',
        heading: 'Details',
        content: '## Details\n\nrewritten',
        expectedVersion: 7,
      })
    );

    expect(message).toContain('appears to be markdown');
    expect(message).not.toContain('construct');
  });

  it('normalizes a Confluence-side version rejection into the same conflict shape', async () => {
    updateConfluencePage.mockRejectedValueOnce(
      new ConfluenceApiError('Version must be incremented', 409)
    );
    getConfluencePage.mockResolvedValueOnce(page()).mockResolvedValueOnce(page({ version: 9 }));

    const message = await failure(() =>
      handleReplaceConfluenceSection({
        pageId: '123456',
        heading: 'Intro',
        content: '<p>new</p>',
        expectedVersion: 7,
      })
    );

    expect(message).toContain('Version conflict');
    expect(message).toContain('version 9');
  });
});

describe('construct loss is scoped to the replaced span (task 6.8b, design.md D6)', () => {
  it('rejects a replacement that drops a macro inside the section, naming it', async () => {
    const message = await failure(() =>
      handleReplaceConfluenceSection({
        pageId: '123456',
        heading: 'Details',
        content: '<p>rewritten without the macro</p>',
        expectedVersion: 7,
      })
    );

    expect(message).toContain('macro "info"');
    expect(message).not.toContain('"toc"');
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });

  it('permits the removal when the caller confirms it', async () => {
    await handleReplaceConfluenceSection({
      pageId: '123456',
      heading: 'Details',
      content: '<p>rewritten without the macro</p>',
      expectedVersion: 7,
      confirmConstructRemoval: true,
    });

    expect(submitted()).not.toContain('ac:name="info"');
    expect(submitted()).toContain('ac:name="toc"');
  });

  it('ignores macros OUTSIDE the span -- the whole-page check would wrongly reject this', async () => {
    await handleReplaceConfluenceSection({
      pageId: '123456',
      heading: 'Intro',
      content: '<p>rewritten</p>',
      expectedVersion: 7,
    });

    expect(submitted()).toContain(INFO_MACRO);
    expect(submitted()).toContain(TOC_MACRO);
  });

  it('passes when the replacement retains every macro in the section', async () => {
    await handleReplaceConfluenceSection({
      pageId: '123456',
      heading: 'Details',
      content: `<p>rewritten</p>${INFO_MACRO}`,
      expectedVersion: 7,
    });

    expect(submitted()).toBe(
      SECTION_PAGE.replace(`<p>detail body</p>${INFO_MACRO}`, `<p>rewritten</p>${INFO_MACRO}`)
    );
  });

  it('append and insert skip the check entirely, since they remove nothing', async () => {
    await handleAppendConfluenceSection({
      pageId: '123456',
      heading: 'Details',
      content: '<p>appended</p>',
      expectedVersion: 7,
    });
    expect(submitted()).toBe(
      SECTION_PAGE.replace(`${INFO_MACRO}<h2>Outro`, `${INFO_MACRO}<p>appended</p><h2>Outro`)
    );

    jest.clearAllMocks();
    getConfluencePage.mockResolvedValue(page());
    updateConfluencePage.mockImplementation(async (_id, title, _content, version) =>
      page({ title, version })
    );

    await handleInsertConfluenceSection({
      pageId: '123456',
      heading: 'Details',
      newHeading: 'Rollback',
      content: '<p>restore</p>',
      expectedVersion: 7,
    });
    expect(submitted()).toContain('<h2>Rollback</h2><p>restore</p><h2>Outro</h2>');
  });
});

describe('assembly is validated before the write (task 6.8a)', () => {
  const LAYOUT_PAGE =
    '<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell>' +
    '<h2>Cell</h2><p>cell body</p>' +
    '</ac:layout-cell></ac:layout-section></ac:layout>';

  it('rejects a fragment that is well-formed alone but breaks the document', async () => {
    getConfluencePage.mockResolvedValue(page({ storage: LAYOUT_PAGE }));

    const message = await failure(() =>
      handleReplaceConfluenceSection({
        pageId: '123456',
        heading: 'Cell',
        content: '<p>a</p><!',
        expectedVersion: 7,
      })
    );

    expect(message).toContain('assembly produced invalid content');
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });
});

describe('unaddressable and unknown headings are rejected at the handler (tasks 6.1b, 6.5)', () => {
  it('a heading that exists only inside a macro body is not found', async () => {
    getConfluencePage.mockResolvedValue(
      page({
        storage: '<h2>Real</h2><p>x</p>' + INFO_MACRO.replace('<p>note</p>', '<h2>Buried</h2>'),
      })
    );

    const message = await failure(() =>
      handleReplaceConfluenceSection({
        pageId: '123456',
        heading: 'Buried',
        content: '<p>new</p>',
        expectedVersion: 7,
      })
    );

    expect(message).toContain('opaque');
    expect(message).toContain('"Real"');
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });

  it('a heading that does not exist lists the ones that do', async () => {
    const message = await failure(() =>
      handleReplaceConfluenceSection({
        pageId: '123456',
        heading: 'Nowhere',
        content: '<p>new</p>',
        expectedVersion: 7,
      })
    );

    expect(message).toContain('"Intro"');
    expect(message).toContain('"Details"');
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });

  it('a page whose stored content is already malformed is refused, not spliced', async () => {
    getConfluencePage.mockResolvedValue(page({ storage: '<h2>Broken</h2><p>x<h2>Next</h2>' }));

    const message = await failure(() =>
      handleReplaceConfluenceSection({
        pageId: '123456',
        heading: 'Broken',
        content: '<p>new</p>',
        expectedVersion: 7,
      })
    );

    expect(message).toContain('not well-formed');
    expect(message).toContain('update_confluence_page');
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });
});

describe('insert builds the new heading itself', () => {
  it('defaults the level to the anchor section and escapes the text', async () => {
    await handleInsertConfluenceSection({
      pageId: '123456',
      heading: 'Intro',
      newHeading: 'Q&A',
      content: '<p>answers</p>',
      expectedVersion: 7,
    });

    expect(submitted()).toContain('<h2>Q&amp;A</h2><p>answers</p><h2>Details</h2>');
  });

  it('accepts an explicit level and an empty body', async () => {
    await handleInsertConfluenceSection({
      pageId: '123456',
      heading: 'Intro',
      newHeading: 'Notes',
      level: 3,
      expectedVersion: 7,
    });

    expect(submitted()).toContain('<h3>Notes</h3><h2>Details</h2>');
  });
});

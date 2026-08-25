import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * `validate_confluence_content` at the handler level (spec: content-validator).
 *
 * Two things cannot be asserted against the pure pipeline and are the whole point of this
 * file: that NO modifying request is ever made, whatever the content or the arguments, and
 * that omitting `pageId` reaches Confluence not at all while supplying it reads the page once.
 *
 * `../src/config.js` is mocked alongside the client -- without it `getInstanceForSpace` reads
 * `~/.confluence-config.json` and the suite becomes machine-dependent.
 */

const getConfluencePage = jest.fn<(pageId: string) => Promise<unknown>>();
const updateConfluencePage = jest.fn();
const createConfluencePage = jest.fn();

jest.mock('../src/client/confluence-client.js', () => ({
  __esModule: true,
  ConfluenceClient: jest.fn().mockImplementation(() => ({
    getConfluencePage,
    updateConfluencePage,
    createConfluencePage,
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

import { handleValidateConfluenceContent } from '../src/handlers/validation-handlers.js';
import { preflight } from '../src/utils/write-safety.js';

const MACRO_PAGE =
  '<p>Intro</p><ac:structured-macro ac:name="toc"><ac:parameter ac:name="minLevel">2' +
  '</ac:parameter></ac:structured-macro><p>Outro</p>';

const DIRTY =
  '<p>## Heading</p><p>[Confluence Macro: toc (minLevel: 2)]</p><p>1. $1</p><b>dangling';

function page(overrides: { version?: number; storage?: string } = {}) {
  return {
    id: '123456',
    status: 'current',
    title: 'Quarterly Plan',
    spaceId: '789',
    version: { number: overrides.version ?? 7, createdAt: '2026-02-02T00:00:00.000Z' },
    body: { storage: { value: overrides.storage ?? MACRO_PAGE, representation: 'storage' } },
    _links: { webui: '/spaces/APA/pages/123456' },
  };
}

interface Report {
  instance?: string;
  valid: boolean;
  scope: string;
  page?: { pageId: string; title: string; version: number; note: string };
  checksRun: string[];
  checksSkipped?: { check: string; reason: string }[];
  overridesApplied?: Record<string, boolean>;
  problemCount: number;
  problems: {
    check: string;
    primary: boolean;
    problem: string;
    location?: { offset?: number; snippet?: string };
    action: string;
  }[];
  summary: string;
  readOnly: string;
}

async function validate(args: Record<string, unknown>): Promise<Report> {
  const result = await handleValidateConfluenceContent(args as never);
  return JSON.parse((result as { content: { text: string }[] }).content[0].text) as Report;
}

/** The assertion that matters most, made after every single case below. */
function expectNothingWritten(): void {
  expect(updateConfluencePage).not.toHaveBeenCalled();
  expect(createConfluencePage).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  getConfluencePage.mockResolvedValue(page());
});

describe('validate_confluence_content is read-only', () => {
  it('never writes, for clean content, dirty content, or a page comparison', async () => {
    await validate({ content: '<p>Fine.</p>' });
    await validate({ content: DIRTY });
    await validate({ content: DIRTY, pageId: '123456' });
    await validate({ content: MACRO_PAGE, pageId: '123456' });

    expectNothingWritten();
    // The only call it is allowed to make, and only on the two page-scoped validations.
    expect(getConfluencePage).toHaveBeenCalledTimes(2);
  });

  it('says so in the response', async () => {
    const report = await validate({ content: DIRTY });
    expect(report.readOnly).toMatch(/never writes/i);
  });
});

describe('without pageId', () => {
  it('contacts Confluence not at all', async () => {
    await validate({ content: DIRTY });

    expect(getConfluencePage).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('runs the content-intrinsic checks and says construct-loss was not evaluated', async () => {
    const report = await validate({ content: '<p>Fine.</p>' });

    expect(report.valid).toBe(true);
    expect(report.scope).toBe('content-only');
    expect(report.checksRun).toEqual([
      'well-formedness',
      'markdown',
      'macro-placeholder',
      'conversion-artifact',
    ]);
    expect(report.checksSkipped).toEqual([
      { check: 'construct-loss', reason: expect.stringMatching(/no pageId was supplied/i) },
    ]);
    expect(report.page).toBeUndefined();
    expect(report.summary).toMatch(/Ready to write/);
  });

  it('points a section-fragment caller at the right scope', async () => {
    const report = await validate({ content: '<p>Fine.</p>' });

    expect(report.checksSkipped?.[0].reason).toMatch(/replace_confluence_section/);
  });
});

describe('problem reporting', () => {
  it('reports EVERY problem, not just the one a write would be rejected on', async () => {
    const report = await validate({ content: DIRTY, pageId: '123456' });

    expect(report.valid).toBe(false);
    expect(report.problemCount).toBe(5);
    expect(report.problems.map((problem) => problem.check)).toEqual([
      'well-formedness',
      'markdown',
      'macro-placeholder',
      'conversion-artifact',
      'construct-loss',
    ]);
    expectNothingWritten();
  });

  it('flags exactly one problem as primary, and it is the write path’s verdict', async () => {
    const report = await validate({ content: DIRTY, pageId: '123456' });
    const writeVerdict = await preflight({ content: DIRTY, currentContent: MACRO_PAGE });

    expect(report.problems.filter((problem) => problem.primary)).toHaveLength(1);
    expect(report.problems[0].primary).toBe(true);
    expect(report.problems[0].check).toBe(writeVerdict?.check);
    expect(report.problems[0].problem).toBe(writeVerdict?.message);
  });

  it('gives every problem a location and a corrective action', async () => {
    const report = await validate({ content: DIRTY, pageId: '123456' });

    for (const problem of report.problems) {
      expect(problem.action.length).toBeGreaterThan(0);
      expect(problem.location).toBeDefined();
      expect(problem.location?.offset ?? problem.location?.snippet).toBeDefined();
    }
    expect(report.summary).toMatch(/5 problem\(s\) found/);
  });
});

describe('with pageId', () => {
  it('reads the page once, compares against it, and returns its version', async () => {
    const report = await validate({ content: MACRO_PAGE, pageId: '123456' });

    expect(getConfluencePage).toHaveBeenCalledTimes(1);
    expect(getConfluencePage).toHaveBeenCalledWith('123456');
    expect(report.valid).toBe(true);
    expect(report.scope).toBe('content-and-page');
    expect(report.checksRun).toContain('construct-loss');
    expect(report.checksSkipped).toBeUndefined();
    expect(report.page).toEqual({
      pageId: '123456',
      title: 'Quarterly Plan',
      version: 7,
      note: expect.stringMatching(/expectedVersion/),
    });
    expect(report.instance).toBe('onvex');
    expectNothingWritten();
  });

  it('catches the construct loss that the content alone cannot show', async () => {
    const contentOnly = await validate({ content: '<p>Rewritten.</p>' });
    const againstPage = await validate({ content: '<p>Rewritten.</p>', pageId: '123456' });

    expect(contentOnly.valid).toBe(true);
    expect(againstPage.valid).toBe(false);
    expect(againstPage.problems[0].check).toBe('construct-loss');
    expect(againstPage.problems[0].problem).toMatch(/macro "toc"/);
    expectNothingWritten();
  });

  it('warns the caller that a whole-page comparison is the wrong scope for a section edit', async () => {
    const report = await validate({ content: MACRO_PAGE, pageId: '123456' });

    expect(report.page?.note).toMatch(/replace_confluence_section/);
  });

  it('reports a failed read as a read failure, without writing', async () => {
    getConfluencePage.mockRejectedValue(new Error('boom'));

    await expect(validate({ content: '<p>Fine.</p>', pageId: '123456' })).rejects.toThrow(
      /Failed to read page 123456 to validate against it/
    );
    expectNothingWritten();
  });
});

describe('overrides mirror the write path', () => {
  it('suppresses the markdown check and says it did', async () => {
    const report = await validate({ content: '<p>## Heading</p>', allowMarkdownContent: true });

    expect(report.valid).toBe(true);
    expect(report.overridesApplied).toEqual({ allowMarkdownContent: true });
    expect(report.checksRun).not.toContain('markdown');
    expect(report.checksSkipped).toEqual([
      { check: 'markdown', reason: expect.stringMatching(/allowMarkdownContent/) },
      { check: 'construct-loss', reason: expect.any(String) },
    ]);
    expect(report.summary).toMatch(/overrides below applied/);
  });

  it('waives construct removal and says it did', async () => {
    const report = await validate({
      content: '<p>Rewritten.</p>',
      pageId: '123456',
      confirmConstructRemoval: true,
    });

    expect(report.valid).toBe(true);
    expect(report.overridesApplied).toEqual({ confirmConstructRemoval: true });
    expect(report.checksSkipped).toEqual([
      { check: 'construct-loss', reason: expect.stringMatching(/confirmConstructRemoval/) },
    ]);
  });
});

describe('argument validation', () => {
  it('rejects a missing content rather than crashing in the tokenizer', async () => {
    await expect(handleValidateConfluenceContent({} as never)).rejects.toThrow(McpError);
    await expect(handleValidateConfluenceContent({} as never)).rejects.toThrow(
      /"content" must be a string/
    );
    expectNothingWritten();
  });

  it('accepts an explicit empty string as empty content', async () => {
    const report = await validate({ content: '' });

    expect(report.valid).toBe(true);
    expect(report.problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gate 2 finding: construct-loss scope for replace_confluence_section fragments
// ---------------------------------------------------------------------------

describe('heading scopes construct-loss to the replaced span (Gate 2 finding)', () => {
  // Without `heading`, a fragment destined for ONE section was compared against the WHOLE
  // page, so a macro living in a different section read as "about to be removed" and the
  // fragment was rejected for a loss that would never happen. The real
  // replace_confluence_section write scopes the same check to the replaced span, so the
  // validator answered a different question than the write it exists to predict.
  const PAGE_WITH_MACRO_ELSEWHERE =
    '<h2>Alpha</h2><p>alpha body</p>' +
    '<h2>Beta</h2><ac:structured-macro ac:name="info"><ac:rich-text-body><p>keep</p></ac:rich-text-body></ac:structured-macro>';

  beforeEach(() => {
    getConfluencePage.mockResolvedValue(page({ storage: PAGE_WITH_MACRO_ELSEWHERE }));
  });

  it('rejects a clean Alpha fragment when scope is whole-page', async () => {
    const report = await validate({ content: '<p>replacement alpha body</p>', pageId: '123456' });

    expect(report.valid).toBe(false);
    expect(JSON.stringify(report.problems)).toContain('info');
    expectNothingWritten();
  });

  it('accepts the same fragment when scoped to its own heading', async () => {
    const report = await validate({
      content: '<p>replacement alpha body</p>',
      pageId: '123456',
      heading: 'Alpha',
    });

    expect(report.valid).toBe(true);
    expectNothingWritten();
  });

  it('still reports a macro dropped from WITHIN the scoped section', async () => {
    const report = await validate({ content: '<p>gutted</p>', pageId: '123456', heading: 'Beta' });

    expect(report.valid).toBe(false);
    expect(JSON.stringify(report.problems)).toContain('info');
    expectNothingWritten();
  });

  it('rejects an unknown heading rather than silently falling back to whole-page', async () => {
    await expect(
      handleValidateConfluenceContent({
        content: '<p>x</p>',
        pageId: '123456',
        heading: 'Nope',
      } as never)
    ).rejects.toThrow(/Cannot scope validation to heading/);
    expectNothingWritten();
  });

  it('rejects an empty-string pageId rather than silently downgrading scope', async () => {
    await expect(
      handleValidateConfluenceContent({ content: '<p>x</p>', pageId: '' } as never)
    ).rejects.toThrow(/empty string/i);
    expectNothingWritten();
  });
});

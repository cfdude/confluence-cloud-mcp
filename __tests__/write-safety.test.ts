import { describe, it, expect } from '@jest/globals';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import {
  PREFLIGHT_CHECK_ORDER,
  assertExpectedVersion,
  assertWellFormed,
  assertWriteIsSafe,
  buildTextProjection,
  detectMarkdownSignals,
  isVersionConflictResponse,
  preflight,
  resolveWriteVersion,
  versionConflictError,
  type PreflightInput,
} from '../src/utils/write-safety.js';
import { tokenize } from '../src/utils/storage-tokenizer.js';
import { ConfluenceApiError } from '../src/types/index.js';
import { listFixtureFiles, loadFixture } from './helpers/fixtures.js';

/** The check that fired, or `null`. Every assertion below is phrased in these terms. */
async function failingCheck(input: PreflightInput): Promise<string | null> {
  const failure = await preflight(input);
  return failure === null ? null : failure.check;
}

async function failureMessage(input: PreflightInput): Promise<string> {
  const failure = await preflight(input);
  if (failure === null) throw new Error('expected a preflight failure, got none');
  return failure.message;
}

const MACRO_PAGE =
  '<p>Intro</p><ac:structured-macro ac:name="toc"><ac:parameter ac:name="minLevel">2' +
  '</ac:parameter></ac:structured-macro><p>Outro</p>';

// ---------------------------------------------------------------------------
// 5.4 -- well-formedness
// ---------------------------------------------------------------------------

describe('well-formedness validation (task 5.4)', () => {
  it('rejects content that is not well-formed storage', async () => {
    expect(await failingCheck({ content: '<p>unclosed' })).toBe('well-formedness');
    expect(await failingCheck({ content: '<b>a</i>' })).toBe('well-formedness');
    expect(await failingCheck({ content: '<p>a<!-- never closed' })).toBe('well-formedness');
  });

  it('describes the defect and its location', async () => {
    const message = await failureMessage({ content: '<p>unclosed' });

    expect(message).toMatch(/not well-formed Confluence storage format/);
    expect(message).toMatch(/offset \d+/);
    expect(message).toMatch(/The page was not modified\./);
  });

  it('accepts well-formed storage, including namespaced and self-closing markup', async () => {
    expect(await failingCheck({ content: '<p>Plain <strong>prose</strong>.</p>' })).toBeNull();
    expect(await failingCheck({ content: MACRO_PAGE })).toBeNull();
    expect(await failingCheck({ content: '<p />' })).toBeNull();
  });

  it('does not treat a bare < in prose as malformed -- 3 < 4 is ordinary text', async () => {
    expect(await failingCheck({ content: '<p>3 < 4</p>' })).toBeNull();
  });

  it('assertWellFormed throws for section editing to reuse on an assembled document (6.8a)', () => {
    expect(() => assertWellFormed('<p>a</p>')).not.toThrow();
    expect(() => assertWellFormed('<p>a', 'assembled document')).toThrow(McpError);
    expect(() => assertWellFormed('<p>a', 'assembled document')).toThrow(
      /Submitted assembled document is not well-formed/
    );
  });
});

// ---------------------------------------------------------------------------
// The text projection -- what makes the content checks see wrapped text
// ---------------------------------------------------------------------------

describe('text projection', () => {
  it('puts a block element’s text on its own line', () => {
    expect(buildTextProjection(tokenize('<p>## Heading</p>'))).toBe('\n## Heading\n');
  });

  it('does NOT break the line for an inline element', () => {
    expect(buildTextProjection(tokenize('<p>See <code>x</code>## y</p>'))).toBe('\nSee ## y\n');
  });

  it('drops the content of code, pre, plain-text-body, and CDATA', () => {
    expect(buildTextProjection(tokenize('<pre>## x</pre>')).trim()).toBe('');
    expect(buildTextProjection(tokenize('<p><code>## x</code></p>')).trim()).toBe('');
    expect(
      buildTextProjection(
        tokenize('<ac:plain-text-body><![CDATA[## x]]></ac:plain-text-body>')
      ).trim()
    ).toBe('');
  });

  it('decodes entities so an escaped signal is still seen', () => {
    expect(buildTextProjection(tokenize('<p>a &amp; b</p>'))).toBe('\na & b\n');
  });
});

// ---------------------------------------------------------------------------
// 5.5 / 5.6 -- markdown submitted as storage
// ---------------------------------------------------------------------------

describe('markdown-as-storage detection (task 5.5, design.md D8)', () => {
  it.each([
    ['a bare markdown heading', '## Executive Summary\n\nSome text.'],
    ['a heading wrapped in a paragraph', '<p>## Executive Summary</p>'],
    ['a six-hash heading', '<p>###### Deep</p>'],
    ['markdown emphasis', '<p>The **key** point.</p>'],
    ['a fenced code block', '<p>Example:</p>\n```js\nconst a = 1;\n```'],
  ])('rejects %s', async (_label, content) => {
    expect(await failingCheck({ content })).toBe('markdown');
  });

  it('does NOT treat a single leading hash as a heading', async () => {
    expect(await failingCheck({ content: '<p># not a heading signal</p>' })).toBeNull();
    expect(
      await failingCheck({ content: '# Title\n\nBody prose with no other signal.' })
    ).toBeNull();
  });

  it('does NOT reject a bare bullet on its own (evidence-backed carve-out)', async () => {
    expect(
      await failingCheck({ content: '<p>- first thought</p><p>- second thought</p>' })
    ).toBeNull();
    expect(await failingCheck({ content: '<p>* an aside</p>' })).toBeNull();
  });

  it('DOES reject a bullet co-occurring with a high-confidence signal', async () => {
    expect(await failingCheck({ content: '<p>## Notes</p><p>- first</p>' })).toBe('markdown');
    expect(await failingCheck({ content: '<p>- **vs. LinkedIn:** cheaper</p>' })).toBe('markdown');
  });

  it('accepts markdown syntax inside a code or preformatted region', async () => {
    expect(await failingCheck({ content: '<pre>## Heading\n- item\n**bold**</pre>' })).toBeNull();
    expect(
      await failingCheck({ content: '<p>Write <code>**bold**</code> like this.</p>' })
    ).toBeNull();
    expect(
      await failingCheck({
        content:
          '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[## Heading\n```\n]]>' +
          '</ac:plain-text-body></ac:structured-macro>',
      })
    ).toBeNull();
  });

  it('accepts a hyphen or asterisk that is not line-initial', async () => {
    expect(
      await failingCheck({ content: '<p>A well-known trade-off, 3 * 4 = 12.</p>' })
    ).toBeNull();
  });

  it('accepts ordinary storage format', async () => {
    expect(
      await failingCheck({
        content: '<h2>Added</h2><ul><li>A <strong>new</strong> thing</li></ul>',
      })
    ).toBeNull();
  });

  it('does not reject any fixture in this repository', async () => {
    for (const file of listFixtureFiles()) {
      expect([file, await failingCheck({ content: loadFixture(file) })]).toEqual([file, null]);
    }
  });

  it('reports both the high-confidence and the ambiguous signals it saw', () => {
    const signals = detectMarkdownSignals('## Heading\n- item\n');

    expect(signals.map((signal) => signal.id)).toEqual(['heading', 'bullet']);
    expect(signals.map((signal) => signal.confidence)).toEqual(['high', 'ambiguous']);
  });
});

describe('the markdown rejection explains the remedy (task 5.6)', () => {
  it('names the problem and points at the storage representation', async () => {
    const message = await failureMessage({ content: '<p>## Summary</p>' });

    expect(message).toMatch(/appears to be markdown, not Confluence storage format/);
    expect(message).toMatch(/format: 'storage'/);
    expect(message).toMatch(/author against that markup/);
    expect(message).toMatch(/The page was not modified\./);
    expect(message).toMatch(/allowMarkdownContent: true/);
  });
});

// ---------------------------------------------------------------------------
// 5.12 -- the dedicated override, and what it is NOT
// ---------------------------------------------------------------------------

describe('markdown override is dedicated and separate (task 5.12, design.md D8)', () => {
  it('allowMarkdownContent permits the write', async () => {
    expect(
      await failingCheck({ content: '<p>## Summary</p>', allowMarkdownContent: true })
    ).toBeNull();
  });

  it('confirmConstructRemoval ALONE does not override a markdown rejection', async () => {
    expect(
      await failingCheck({ content: '<p>## Summary</p>', confirmConstructRemoval: true })
    ).toBe('markdown');
  });

  it('confirmConstructRemoval does not override markdown even when a macro is also lost', async () => {
    expect(
      await failingCheck({
        content: '<p>## Summary</p>',
        currentContent: MACRO_PAGE,
        confirmConstructRemoval: true,
      })
    ).toBe('markdown');
  });
});

// ---------------------------------------------------------------------------
// 5.11 -- this server's own macro placeholder
// ---------------------------------------------------------------------------

describe('macro-placeholder detection (task 5.11, design.md D8)', () => {
  it('rejects the placeholder text', async () => {
    expect(
      await failingCheck({ content: '<p>[Confluence Macro: toc (minLevel: 2, maxLevel: 3)]</p>' })
    ).toBe('macro-placeholder');
  });

  it('rejects it when a parameter VALUE contains a closing bracket', async () => {
    // The label embeds parameter values and does not escape `]`, so a detector written as
    // /\[Confluence Macro:[^\]]*\]/ stops at the wrong bracket. This one never looks for the
    // closing bracket at all.
    expect(
      await failingCheck({ content: '<p>[Confluence Macro: toc (style: square], depth: 3)]</p>' })
    ).toBe('macro-placeholder');
  });

  it('rejects a bare placeholder with no parameters', async () => {
    expect(await failingCheck({ content: '[Confluence Macro: expand]' })).toBe('macro-placeholder');
  });

  it('accepts it inside a code block -- documentation of the format', async () => {
    expect(
      await failingCheck({ content: '<p>Renders as <code>[Confluence Macro: toc]</code>.</p>' })
    ).toBeNull();
    expect(await failingCheck({ content: '<pre>[Confluence Macro: toc]</pre>' })).toBeNull();
  });

  it('is NOT lifted by the markdown override -- they assert unrelated things', async () => {
    expect(
      await failingCheck({
        content: '<p>[Confluence Macro: toc]</p>',
        allowMarkdownContent: true,
      })
    ).toBe('macro-placeholder');
  });

  it('directs the caller to storage format and offers the code-block remedy', async () => {
    const message = await failureMessage({ content: '<p>[Confluence Macro: toc]</p>' });

    expect(message).toMatch(/rendered macro placeholder/);
    expect(message).toMatch(/format: 'storage'/);
    expect(message).toMatch(/<code> or <pre>/);
    expect(message).toMatch(/The page was not modified\./);
  });
});

// ---------------------------------------------------------------------------
// 5.8 -- the $1 conversion artifact
// ---------------------------------------------------------------------------

describe('conversion-artifact detection (task 5.8, design.md D6)', () => {
  it('rejects the bare-text signature -- the shape on the one live corrupted page', async () => {
    expect(await failingCheck({ content: '<p>1. $1  2. $1  3. $1</p>' })).toBe(
      'conversion-artifact'
    );
    expect(await failingCheck({ content: '1. $1' })).toBe('conversion-artifact');
  });

  it('rejects a list item whose entire text is $1', async () => {
    expect(await failingCheck({ content: '<ol><li>$1</li><li>$1</li></ol>' })).toBe(
      'conversion-artifact'
    );
    expect(await failingCheck({ content: '<ul><li> $1 </li></ul>' })).toBe('conversion-artifact');
  });

  it.each([['$1.2M'], ['$1K'], ['$1,505,674']])('accepts the dollar amount %s', async (amount) => {
    expect(
      await failingCheck({ content: `<p>Revenue reached ${amount} last year.</p>` })
    ).toBeNull();
  });

  it('accepts a parameter placeholder inside a code region', async () => {
    expect(await failingCheck({ content: '<p>Bind <code>$1::vector</code> here.</p>' })).toBeNull();
    expect(
      await failingCheck({ content: '<pre>SELECT * FROM t WHERE e = $1::vector;</pre>' })
    ).toBeNull();
  });

  it('accepts a list item whose $1 is inside a code element', async () => {
    expect(await failingCheck({ content: '<ul><li><code>$1</code></li></ul>' })).toBeNull();
  });

  it('accepts an ordinary numbered list', async () => {
    expect(await failingCheck({ content: '<ol><li>First</li><li>Second</li></ol>' })).toBeNull();
  });

  it('explains that the content came from a lossy read', async () => {
    const message = await failureMessage({ content: '<p>1. $1</p>' });

    expect(message).toMatch(/markdown-conversion artifact/);
    expect(message).toMatch(/format: 'storage'/);
    expect(message).toMatch(/The page was not modified\./);
  });
});

// ---------------------------------------------------------------------------
// 5.9 / 5.10 -- construct loss
// ---------------------------------------------------------------------------

const LAYOUT_PAGE =
  '<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell><p>Body</p>' +
  '</ac:layout-cell></ac:layout-section></ac:layout>';

describe('construct-loss detection (tasks 5.9, 5.10, design.md D6)', () => {
  it('rejects a submission that drops a macro, naming it', async () => {
    const failure = await preflight({
      content: '<p>Intro</p><p>Outro</p>',
      currentContent: MACRO_PAGE,
    });

    expect(failure?.check).toBe('construct-loss');
    expect(failure?.message).toMatch(/macro "toc"/);
    expect(failure?.message).toMatch(/page has 1, submission has 0/);
    expect(failure?.message).toMatch(/confirmConstructRemoval: true/);
  });

  it('rejects a submission that drops a layout', async () => {
    const failure = await preflight({ content: '<p>Body</p>', currentContent: LAYOUT_PAGE });

    expect(failure?.check).toBe('construct-loss');
    expect(failure?.message).toMatch(/layout element "ac:layout"/);
  });

  it('detects dropping ONE of several identical macros -- counts are a multiset', async () => {
    const three = new Array(3)
      .fill(
        '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>'
      )
      .join('');
    const two = new Array(2)
      .fill(
        '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>'
      )
      .join('');

    expect(await failingCheck({ content: two, currentContent: three })).toBe('construct-loss');
    expect(await failingCheck({ content: three, currentContent: three })).toBeNull();
  });

  it('permits the removal when the caller confirms it', async () => {
    expect(
      await failingCheck({
        content: '<p>Intro</p><p>Outro</p>',
        currentContent: MACRO_PAGE,
        confirmConstructRemoval: true,
      })
    ).toBeNull();
  });

  it('passes when every macro is retained', async () => {
    expect(await failingCheck({ content: MACRO_PAGE, currentContent: MACRO_PAGE })).toBeNull();
  });

  it('passes on a page with no macros or layouts', async () => {
    expect(
      await failingCheck({ content: '<p>New</p>', currentContent: '<p>Old</p><h2>H</h2>' })
    ).toBeNull();
  });

  it('does not fire on a macro PARAMETER change -- the scope is macros and layouts', async () => {
    // ac:parameter is inventoried as a namespaced construct, but comparing namespaced elements
    // would reject a legitimate edit that merely retitles a macro. Section 6 inherits this
    // scope when it runs the check over a span.
    const before =
      '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Before</ac:parameter>' +
      '<ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>';
    const after =
      '<ac:structured-macro ac:name="info">' +
      '<ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>';

    expect(await failingCheck({ content: after, currentContent: before })).toBeNull();
  });

  it('is SKIPPED entirely when no current content is supplied -- the create path (D11)', async () => {
    expect(await failingCheck({ content: '<p>Plain new page</p>' })).toBeNull();
  });

  it('compares against a SPAN of the current content, for span-scoped section edits (6.8b)', async () => {
    const page = `<h2>A</h2>${MACRO_PAGE}<h2>B</h2>${LAYOUT_PAGE}`;
    const macroSpan = { start: page.indexOf('<p>Intro'), end: page.indexOf('<h2>B</h2>') };

    // The layout lives outside the span, so replacing the span without it is fine.
    expect(
      await failingCheck({
        content: '<p>Intro</p><p>Outro</p>',
        currentContent: page,
        currentSpan: macroSpan,
      })
    ).toBe('construct-loss');
    expect(
      await failingCheck({ content: MACRO_PAGE, currentContent: page, currentSpan: macroSpan })
    ).toBeNull();
  });

  it('resolves current content lazily -- an earlier failure never fetches it', async () => {
    let fetched = 0;
    const resolver = () => {
      fetched += 1;
      return MACRO_PAGE;
    };

    expect(await failingCheck({ content: '<p>## Markdown</p>', currentContent: resolver })).toBe(
      'markdown'
    );
    expect(fetched).toBe(0);

    expect(await failingCheck({ content: '<p>Plain</p>', currentContent: resolver })).toBe(
      'construct-loss'
    );
    expect(fetched).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5.13 -- check order
// ---------------------------------------------------------------------------

describe('preflight check order (task 5.13, design.md D10)', () => {
  it('is pinned as data so section 6 cannot reuse the checks in another order', () => {
    expect(PREFLIGHT_CHECK_ORDER).toEqual([
      'well-formedness',
      'markdown',
      'macro-placeholder',
      'conversion-artifact',
      'construct-loss',
    ]);
  });

  it('reports markdown, not construct loss, for markdown submitted over a macro page', async () => {
    const failure = await preflight({
      content: '## Executive Summary\n\n- a point\n',
      currentContent: MACRO_PAGE,
    });

    expect(failure?.check).toBe('markdown');
    expect(failure?.message).toMatch(/appears to be markdown/);
    expect(failure?.message).not.toMatch(/would remove/);
  });

  it('reports well-formedness ahead of markdown', async () => {
    expect(await failingCheck({ content: '<p>## Summary' })).toBe('well-formedness');
  });

  it('reports the macro placeholder ahead of the $1 artifact', async () => {
    expect(await failingCheck({ content: '<p>[Confluence Macro: toc]</p><p>1. $1</p>' })).toBe(
      'macro-placeholder'
    );
  });

  it('reports the artifact ahead of construct loss', async () => {
    expect(await failingCheck({ content: '<p>1. $1</p>', currentContent: MACRO_PAGE })).toBe(
      'conversion-artifact'
    );
  });
});

describe('assertWriteIsSafe (task 5.16)', () => {
  it('throws the failure verbatim as an McpError', async () => {
    await expect(assertWriteIsSafe({ content: '<p>## Summary</p>' })).rejects.toThrow(McpError);
    await expect(assertWriteIsSafe({ content: '<p>## Summary</p>' })).rejects.toThrow(
      /appears to be markdown/
    );
  });

  it('resolves silently for content that passes every check', async () => {
    await expect(
      assertWriteIsSafe({ content: MACRO_PAGE, currentContent: MACRO_PAGE })
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5.2 / 5.3 / 5.15 -- versions and the uniform conflict shape
// ---------------------------------------------------------------------------

describe('version resolution (task 5.2, design.md D5)', () => {
  it('writes current + 1', () => {
    expect(resolveWriteVersion(7)).toBe(8);
    expect(resolveWriteVersion(1)).toBe(2);
  });
});

describe('expectedVersion conflict detection (task 5.3)', () => {
  it('passes when the expectation matches', () => {
    expect(() => assertExpectedVersion(7, 7)).not.toThrow();
  });

  it('passes when no expectation was supplied', () => {
    expect(() => assertExpectedVersion(undefined, 7)).not.toThrow();
  });

  it('reports both versions when the expectation is stale', () => {
    expect(() => assertExpectedVersion(7, 9)).toThrow(McpError);
    expect(() => assertExpectedVersion(7, 9)).toThrow(
      /expected version 7 but the page is at version 9/
    );
    expect(() => assertExpectedVersion(7, 9)).toThrow(/The page was not modified\./);
  });
});

describe('conflict error shape is uniform (task 5.15, design.md D12)', () => {
  it('is produced by ONE constructor, so both detectors agree by construction', () => {
    const local = (() => {
      try {
        assertExpectedVersion(7, 9);
      } catch (error) {
        return error as McpError;
      }
      throw new Error('expected a conflict');
    })();

    expect(local.message).toBe(
      versionConflictError({ expectedVersion: 7, currentVersion: 9 }).message
    );
    expect(local.code).toBe(versionConflictError({ expectedVersion: 7, currentVersion: 9 }).code);
  });

  it('keeps the shape when the current version could not be re-read', () => {
    const error = versionConflictError({ expectedVersion: 7, currentVersion: null });

    expect(error).toBeInstanceOf(McpError);
    expect(error.message).toMatch(/Version conflict: this write expected version 7/);
    expect(error.message).toMatch(/The page was not modified\./);
  });
});

describe('classifying Confluence’s own version rejection (task 5.15)', () => {
  it('classifies a 409 as a conflict whatever it says', () => {
    expect(isVersionConflictResponse(new ConfluenceApiError('Conflict', 409))).toBe(true);
  });

  it('classifies a 400 that mentions the version as a conflict', () => {
    expect(
      isVersionConflictResponse(
        new ConfluenceApiError('Confluence API Error: Version must be incremented on update.', 400)
      )
    ).toBe(true);
  });

  it('does not classify unrelated failures', () => {
    expect(isVersionConflictResponse(new ConfluenceApiError('Not found', 404))).toBe(false);
    expect(isVersionConflictResponse(new ConfluenceApiError('Server error', 500))).toBe(false);
    expect(
      isVersionConflictResponse(new ConfluenceApiError('No permission for this version', 403))
    ).toBe(false);
    expect(isVersionConflictResponse(new Error('socket hang up'))).toBe(false);
    expect(isVersionConflictResponse('nope')).toBe(false);
  });
});

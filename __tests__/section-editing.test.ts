/**
 * Section resolution and splicing (spec: page-section-editing; design.md D3, D6).
 *
 * Everything here is pure: a storage string in, offsets and a spliced string out. The
 * handler-level guarantees -- expected version, preflight, no-request-on-rejection -- live in
 * `section-handlers.test.ts`.
 *
 * A NOTE ON TASKS 6.1a AND 6.1e, whose wording reads as a contradiction. Both say a section
 * whose extent runs PAST a nested construct (a macro body, a layout) leaves that construct
 * "byte-identical" when the section is replaced. Taken literally those cannot both hold: if
 * the extent covers the construct, replacing the section replaces the construct too. The rule
 * they are actually pinning down is the OFFSET rule -- `sectionEnd` must land on the next
 * addressable same-container heading, never on a heading nested inside the construct, because
 * that is the splice that orphans closing tags. So each is tested as:
 *
 *   1. the discriminating offset assertion (a naive transitive-containment resolver fails it),
 *   2. the assembled document is still well-formed and the construct is intact, not truncated,
 *   3. byte-identity asserted where it is actually true -- replacing a LATER section, which is
 *      the case the "content before is unchanged" scenario covers, and
 *   4. (in the handler suite) span-scoped construct-loss rejects a replacement that would drop
 *      the construct, which is what makes the wide extent safe rather than destructive.
 */

import { describe, it, expect } from '@jest/globals';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import { loadFixture } from './helpers/fixtures.js';
import {
  assertAssembledWellFormed,
  buildInsertedSection,
  operationSpan,
  resolveSection,
  spliceSection,
  type ResolvedSection,
  type SectionOperation,
} from '../src/utils/section-editing.js';
import { collectConstructs } from '../src/utils/storage-constructs.js';
import { isWellFormed, tokenize } from '../src/utils/storage-tokenizer.js';

function sectionOf(source: string, heading: string, occurrence?: number): ResolvedSection {
  return resolveSection(tokenize(source), { heading, occurrence });
}

function edit(
  source: string,
  heading: string,
  operation: SectionOperation,
  fragment: string,
  occurrence?: number
): string {
  const section = sectionOf(source, heading, occurrence);
  return spliceSection(source, operationSpan(section, operation), fragment);
}

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof McpError) return error.message;
    throw error;
  }
  throw new Error('expected the call to throw');
}

const PLAIN = loadFixture('plain');
const ADDED_BODY = '<ul><li>note A</li><li>note B</li></ul>';

describe('three offsets per heading (task 6.1)', () => {
  it('reports headingStart, bodyStart and sectionEnd as distinct positions', () => {
    const section = sectionOf(PLAIN, 'Added');

    expect(section.headingStart).toBe(PLAIN.indexOf('<h2>Added</h2>'));
    expect(section.bodyStart).toBe(PLAIN.indexOf('<h2>Added</h2>') + '<h2>Added</h2>'.length);
    expect(section.sectionEnd).toBe(PLAIN.indexOf('<h2>Fixed</h2>'));
    expect(PLAIN.slice(section.bodyStart, section.sectionEnd)).toBe(ADDED_BODY);
  });

  it('replace acts on bodyStart..sectionEnd, so the heading survives and is not duplicated', () => {
    const result = edit(PLAIN, 'Added', 'replace', '<p>rewritten</p>');

    expect(result).toBe(PLAIN.replace(ADDED_BODY, '<p>rewritten</p>'));
    expect(result.split('<h2>Added</h2>').length - 1).toBe(1);
    expect(result.split('</h2>').length - 1).toBe(PLAIN.split('</h2>').length - 1);
  });

  it('bodyStart is past the closing tag, not at it (the </h2>-swallowing bug)', () => {
    const section = sectionOf(PLAIN, 'Added');
    const element = tokenize(PLAIN).elements[section.elementIndex];

    expect(section.bodyStart).toBe(element.end);
    expect(section.bodyStart).toBeGreaterThan(element.contentEnd);
    expect(edit(PLAIN, 'Added', 'replace', '')).toContain('<h2>Added</h2><h2>Fixed</h2>');
  });

  it('a final section extends to the end of the page content', () => {
    const section = sectionOf(PLAIN, 'Fixed');
    expect(section.sectionEnd).toBe(PLAIN.length);
  });

  it('a section ends at the next same-level heading and excludes it', () => {
    const section = sectionOf(PLAIN, 'Added');
    expect(PLAIN.slice(section.bodyStart, section.sectionEnd)).not.toContain('<h2>Fixed');
  });

  it('a section ends at a HIGHER-level heading too', () => {
    const source = '<h2>Alpha</h2><p>a</p><h1>Beta</h1><p>b</p>';
    expect(sectionOf(source, 'Alpha').sectionEnd).toBe(source.indexOf('<h1>Beta</h1>'));
  });
});

describe('subsections are included in a parent section (task 6.2)', () => {
  const source = loadFixture('heading-subsections');

  it('a level-2 section extends past its level-3 subsections', () => {
    const section = sectionOf(source, 'Deployment Steps');

    expect(section.sectionEnd).toBe(source.indexOf('<h2>Monitoring</h2>'));
    const body = source.slice(section.bodyStart, section.sectionEnd);
    expect(body).toContain('<h3>Prerequisites</h3>');
    expect(body).toContain('<h3>Rollback</h3>');
  });

  it('a level-3 section ends at the next level-3 heading', () => {
    const section = sectionOf(source, 'Prerequisites');
    expect(section.sectionEnd).toBe(source.indexOf('<h3>Rollback</h3>'));
  });

  it('the last subsection ends where its parent section ends', () => {
    expect(sectionOf(source, 'Rollback').sectionEnd).toBe(source.indexOf('<h2>Monitoring</h2>'));
  });
});

describe('macro bodies are opaque (tasks 6.1a, 6.1b)', () => {
  const source = loadFixture('heading-in-macro-body');
  const MACRO_START = source.indexOf('<ac:structured-macro');
  const MACRO_END = source.indexOf('</ac:structured-macro>') + '</ac:structured-macro>'.length;
  const MACRO = source.slice(MACRO_START, MACRO_END);

  it('sectionEnd skips the heading inside the macro body and lands on the next real heading', () => {
    const section = sectionOf(source, 'A');

    expect(section.sectionEnd).toBe(source.indexOf('<h2>C</h2>'));
    expect(section.sectionEnd).not.toBe(source.indexOf('<h2>B</h2>'));
  });

  it('replacing that section splices at a sibling boundary, never inside the macro', () => {
    const result = edit(source, 'A', 'replace', '<p>fresh</p>');

    expect(isWellFormed(tokenize(result))).toBe(true);
    expect(result).not.toContain('</ac:rich-text-body>');
    expect(result).toBe(
      source.replace(/^<h2>A<\/h2>[\s\S]*<h2>C<\/h2>/, '<h2>A</h2><p>fresh</p><h2>C</h2>')
    );
  });

  it('replacing a LATER section leaves the macro and the paragraph after it byte-identical', () => {
    const result = edit(source, 'C', 'replace', '<p>fresh</p>');

    expect(result).toContain(MACRO);
    expect(result.slice(0, MACRO_END)).toBe(source.slice(0, MACRO_END));
    expect(result).toContain('<p>z</p>');
  });

  it('a heading inside a macro body is not addressable and the error names only addressable ones', () => {
    const message = messageOf(() => sectionOf(source, 'B'));

    expect(message).toContain('ac:structured-macro');
    expect(message).toContain('addressable headings');
    expect(message).toContain('"A"');
    expect(message).toContain('"C"');
    expect(message).not.toContain('"B" (h2');
  });
});

describe('table cells are opaque (task 6.1b)', () => {
  const source = loadFixture('heading-in-table-cell');

  it('a heading inside a table cell is not addressable', () => {
    const message = messageOf(() => sectionOf(source, 'Cell Heading'));
    expect(message).toContain('<td>');
    expect(message).toContain('addressable headings');
  });

  it('the table does not truncate the enclosing section', () => {
    const section = sectionOf(source, 'Outer');
    expect(section.sectionEnd).toBe(source.indexOf('<h2>Next</h2>'));
    expect(source.slice(section.bodyStart, section.sectionEnd)).toContain('</table>');
  });
});

describe('layout cells are sectioning containers (task 6.1c)', () => {
  const source = loadFixture('heading-in-layout-cells');

  it('a heading inside a layout cell is addressable', () => {
    expect(sectionOf(source, 'Left One').container.name).toBe('ac:layout-cell');
  });

  it('a section ends at the next heading in the SAME cell', () => {
    expect(sectionOf(source, 'Left One').sectionEnd).toBe(source.indexOf('<h2>Left Two</h2>'));
  });

  it('the last section in a cell ends at that cell, not at the next cell', () => {
    const section = sectionOf(source, 'Left Two');
    const cellEnd = source.indexOf('</ac:layout-cell>');

    expect(section.sectionEnd).toBe(cellEnd);
    expect(section.sectionEnd).toBeLessThan(source.indexOf('<h2>Right One</h2>'));
  });

  it('replacing a section in one cell leaves every other cell byte-identical', () => {
    const rightCell = source.slice(
      source.indexOf('<ac:layout-cell>', source.indexOf('</ac:layout-cell>')),
      source.lastIndexOf('</ac:layout-cell>') + '</ac:layout-cell>'.length
    );
    const result = edit(source, 'Left Two', 'replace', '<p>rewritten</p>');

    expect(result).toContain(rightCell);
    expect(result).toContain('<h2>Right One</h2>');
    expect(isWellFormed(tokenize(result))).toBe(true);
  });

  it('a heading directly inside ac:layout-section resolves to that container, not a cell', () => {
    // The `sectioning`-but-not-a-cell path. Every other layout test here lands on
    // `ac:layout-cell`, so without this the container-end fallback for `ac:layout-section`
    // (and `ac:layout`) never executes.
    const direct =
      '<ac:layout><ac:layout-section ac:type="single"><h2>Direct</h2><p>x</p>' +
      '</ac:layout-section></ac:layout>';
    const section = sectionOf(direct, 'Direct');

    expect(section.container.name).toBe('ac:layout-section');
    expect(section.sectionEnd).toBe(section.container.contentEnd);
    expect(direct.slice(section.sectionEnd)).toBe('</ac:layout-section></ac:layout>');
    expect(edit(direct, 'Direct', 'replace', '<p>y</p>')).toBe(
      direct.replace('<p>x</p>', '<p>y</p>')
    );
  });

  it('a macro inside a cell does not truncate that cell section', () => {
    const section = sectionOf(source, 'Right One');
    expect(section.sectionEnd).toBe(source.indexOf('<h2>Right Two</h2>'));
    expect(source.slice(section.bodyStart, section.sectionEnd)).toContain('ac:structured-macro');
  });
});

describe('nearest-container scoping on the composite shape (task 6.1e)', () => {
  const source = loadFixture('composite-root-heading-then-layout');
  const LAYOUT_START = source.indexOf('<ac:layout>');
  const LAYOUT_END = source.indexOf('</ac:layout>') + '</ac:layout>'.length;
  const LAYOUT = source.slice(LAYOUT_START, LAYOUT_END);

  it('a root-level section runs past a layout whose cells contain same-level headings', () => {
    const section = sectionOf(source, 'Root Section');

    // The assertion that discriminates: a resolver using transitive containment rather than
    // nearest-container would stop at `<h2>Cell Left</h2>` and splice inside the layout cell.
    expect(section.sectionEnd).toBe(source.indexOf('<h2>Second Root Section</h2>'));
    expect(section.sectionEnd).not.toBe(source.indexOf('<h2>Cell Left</h2>'));
    expect(section.container.kind).toBe('root');
  });

  it('a cell heading is scoped to its own cell, not to the root', () => {
    const left = sectionOf(source, 'Cell Left');

    expect(left.container.name).toBe('ac:layout-cell');
    expect(left.sectionEnd).toBeLessThan(source.indexOf('<h2>Cell Right</h2>'));
    expect(left.sectionEnd).toBeLessThan(source.indexOf('<h2>Second Root Section</h2>'));
  });

  it('replacing the root-level section keeps the layout whole rather than truncating it', () => {
    const result = edit(source, 'Root Section', 'replace', '<p>fresh</p>');

    expect(isWellFormed(tokenize(result))).toBe(true);
    expect(result).not.toContain('</ac:layout-cell>');
    expect(result).toContain('<h2>Second Root Section</h2>');
  });

  it('replacing the SECOND root section preserves the entire layout byte-for-byte', () => {
    const result = edit(source, 'Second Root Section', 'replace', '<p>fresh</p>');

    expect(result).toContain(LAYOUT);
    expect(result.slice(0, LAYOUT_END)).toBe(source.slice(0, LAYOUT_END));
    expect(result).toContain('<h2>Cell Left</h2>');
    expect(result).toContain('<h2>Cell Right</h2>');
  });
});

describe('the same-container invariant is asserted, not assumed (task 6.1d)', () => {
  it('an addressable heading is always a direct child of its nearest container', () => {
    for (const name of ['plain', 'heading-in-layout-cells', 'captured-layout-table-macros']) {
      const source = loadFixture(name);
      const result = tokenize(source);
      for (const element of result.elements) {
        if (!/^h[1-6]$/.test(element.name)) continue;
        const section = (() => {
          try {
            return resolveSection(result, {
              heading: source.slice(element.contentStart, element.contentEnd),
            });
          } catch {
            return null;
          }
        })();
        if (!section) continue;
        expect(section.bodyStart).toBeLessThanOrEqual(section.sectionEnd);
        expect(section.sectionEnd).toBeLessThanOrEqual(section.container.contentEnd);
        expect(section.headingStart).toBeGreaterThanOrEqual(section.container.contentStart);
      }
    }
  });

  it('a heading inside a plain <div> is NOT addressable, and that is load-bearing', () => {
    // design.md D3 read literally: every ancestor must be a sectioning container. Relaxing
    // this to "no OPAQUE ancestor" would give this heading the document ROOT as its nearest
    // container, so its sectionEnd would be computed among root-level headings outside the
    // div and the splice would cross `</div>`. See section-editing.ts's module comment.
    const source = '<div><h2>Inside</h2><p>x</p></div><h2>Outside</h2><p>y</p>';
    const message = messageOf(() => sectionOf(source, 'Inside'));

    expect(message).toContain('<div>');
    expect(message).toContain('"Outside"');
    expect(sectionOf(source, 'Outside').container.kind).toBe('root');
  });
});

describe('ambiguity and absence are errors, not guesses (tasks 6.3, 6.4, 6.5)', () => {
  const source = '<h2>Notes</h2><p>one</p><h2>Notes</h2><p>two</p><h2>Other</h2><p>three</p>';

  it('a duplicate heading without an occurrence index is rejected with the match count', () => {
    const message = messageOf(() => sectionOf(source, 'Notes'));

    expect(message).toContain('matches 2 headings');
    expect(message).toContain('occurrence');
  });

  it('an occurrence index selects the intended match', () => {
    expect(sectionOf(source, 'Notes', 1).bodyStart).toBe(source.indexOf('<p>one</p>'));
    expect(sectionOf(source, 'Notes', 2).bodyStart).toBe(source.indexOf('<p>two</p>'));
    expect(edit(source, 'Notes', 'replace', '<p>2</p>', 2)).toBe(
      source.replace('<p>two</p>', '<p>2</p>')
    );
  });

  it('an occurrence index that does not exist is rejected', () => {
    expect(messageOf(() => sectionOf(source, 'Notes', 5))).toContain('occurrence 5');
  });

  it('a missing heading is rejected with a list of the headings that do exist', () => {
    const message = messageOf(() => sectionOf(source, 'Nope'));

    expect(message).toContain('No heading matching "Nope"');
    expect(message).toContain('"Notes" (h2, occurrence 1)');
    expect(message).toContain('"Notes" (h2, occurrence 2)');
    expect(message).toContain('"Other"');
  });

  it('a page with no headings reports that rather than a match failure', () => {
    expect(messageOf(() => sectionOf('<p>no headings here</p>', 'Anything'))).toContain(
      'no headings'
    );
  });
});

describe('heading matching uses foldHeadingText, with a case-insensitive FALLBACK only', () => {
  it('folds curly apostrophes and collapses whitespace, as the outline does', () => {
    const source = '<h2>Ops&rsquo;  plan</h2><p>x</p><h2>Next</h2>';
    expect(sectionOf(source, "Ops' plan").bodyStart).toBe(source.indexOf('<p>x</p>'));
  });

  it('falls back to case-insensitive matching only when the exact fold finds nothing', () => {
    const source = '<h2>Deployment Steps</h2><p>x</p><h2>Next</h2>';
    expect(sectionOf(source, 'deployment steps').bodyStart).toBe(source.indexOf('<p>x</p>'));
  });

  it('never renumbers occurrences: a case-folded multi-match is ambiguous, always', () => {
    const source = '<h2>Setup</h2><p>one</p><h2>setup</h2><p>two</p>';
    const message = messageOf(() => sectionOf(source, 'SETUP', 1));

    expect(message).toContain('letter case');
    expect(message).toContain('exactly as get_confluence_page reports it');
    // The exact fold still resolves each of them on its own.
    expect(sectionOf(source, 'Setup').bodyStart).toBe(source.indexOf('<p>one</p>'));
    expect(sectionOf(source, 'setup').bodyStart).toBe(source.indexOf('<p>two</p>'));
  });
});

describe('the splice preserves everything outside the span (tasks 6.6, 6.11)', () => {
  const captured = loadFixture('captured-layout-table-macros');

  it('replacing a section of a macro-heavy real page leaves both sides byte-identical', () => {
    const section = sectionOf(captured, 'Xi lorem');
    const span = operationSpan(section, 'replace');
    const before = captured.slice(0, span.start);
    const after = captured.slice(span.end);

    const result = spliceSection(captured, span, '<p>rewritten</p>');

    expect(result.slice(0, span.start)).toBe(before);
    expect(result.slice(span.start + '<p>rewritten</p>'.length)).toBe(after);
    expect(result).toBe(before + '<p>rewritten</p>' + after);
    expect(isWellFormed(tokenize(result))).toBe(true);
  });

  it('bounds consecutive sections in one cell, then falls back to the cell end', () => {
    // On the real page both of these h1s share one `ac:layout-cell`, so the first is bounded
    // by the second and the second falls back to the cell's own contentEnd.
    const first = sectionOf(captured, 'Mu fugiat excepteur');
    const second = sectionOf(captured, 'Ipsum sunt: Aliqua & kappa');

    expect(first.container.index).toBe(second.container.index);
    expect(first.sectionEnd).toBe(second.headingStart);
    expect(second.sectionEnd).toBe(second.container.contentEnd);
    expect(captured.slice(second.sectionEnd, second.sectionEnd + 17)).toBe('</ac:layout-cell>');
  });

  it('every macro outside the replaced span survives as the exact same bytes', () => {
    const section = sectionOf(captured, 'Xi lorem');
    const span = operationSpan(section, 'replace');
    const macros = collectConstructs(tokenize(captured)).occurrences.filter(
      (occurrence) => occurrence.category === 'macro'
    );
    const outside = macros.filter(
      (occurrence) => occurrence.end <= span.start || occurrence.start >= span.end
    );

    const result = spliceSection(captured, span, '<p>rewritten</p>');

    expect(outside.length).toBeGreaterThan(0);
    expect(outside.length).toBeLessThan(macros.length);
    for (const occurrence of outside) {
      expect(result).toContain(captured.slice(occurrence.start, occurrence.end));
    }
  });

  it('unknown third-party markup on either side of the edited section is untouched', () => {
    const unknown = loadFixture('unknown-markup');
    const source = `<h2>Alpha</h2>${unknown}<h2>Beta</h2><p>b</p><h2>Gamma</h2>${unknown}`;

    const result = edit(source, 'Beta', 'replace', '<p>rewritten</p>');

    expect(result.split(unknown).length - 1).toBe(2);
    expect(result).toBe(source.replace('<p>b</p>', '<p>rewritten</p>'));
    expect(result).toContain('<x-widget data-source="feed" data-limit="5">');
    expect(result).toContain('ac:name="thirdparty-report"');
  });
});

describe('the three operations (task 6.7)', () => {
  it('replace substitutes only the body and keeps the heading once', () => {
    expect(edit(PLAIN, 'Added', 'replace', '<p>new</p>')).toBe(
      PLAIN.replace(ADDED_BODY, '<p>new</p>')
    );
  });

  it('append adds at the end of the section, keeping the existing body ahead of it', () => {
    expect(edit(PLAIN, 'Added', 'append', '<p>extra</p>')).toBe(
      PLAIN.replace(`${ADDED_BODY}<h2>Fixed`, `${ADDED_BODY}<p>extra</p><h2>Fixed`)
    );
  });

  it('append to the final section lands at the very end of the page', () => {
    expect(edit(PLAIN, 'Fixed', 'append', '<p>tail</p>')).toBe(`${PLAIN}<p>tail</p>`);
  });

  it('insert places a new section immediately after the named one, unchanged', () => {
    const fragment = buildInsertedSection('Known Issues', 2, '<p>none</p>');
    const result = edit(PLAIN, 'Added', 'insert-after', fragment);

    expect(fragment).toBe('<h2>Known Issues</h2><p>none</p>');
    expect(result).toBe(
      PLAIN.replace(`${ADDED_BODY}<h2>Fixed`, `${ADDED_BODY}${fragment}<h2>Fixed`)
    );
    expect(result).toContain(`<h2>Added</h2>${ADDED_BODY}`);
  });

  it('an inserted heading escapes text rather than trusting it as markup', () => {
    expect(buildInsertedSection('Q&A <script>', 3, '')).toBe('<h3>Q&amp;A &lt;script&gt;</h3>');
  });

  it('an inserted heading rejects a level outside 1-6', () => {
    expect(messageOf(() => buildInsertedSection('x', 7, ''))).toContain('1 to 6');
  });
});

describe('no whitespace is adjusted at a splice boundary (task 6.12)', () => {
  const source = '<h2>One</h2>\n  <p>body</p>\n\n<h2>Two</h2>\n<p>tail</p>';

  it('the bytes before an append insertion point are unchanged, with nothing added', () => {
    const section = sectionOf(source, 'One');
    const result = edit(source, 'One', 'append', '<p>added</p>');

    expect(source.slice(section.sectionEnd - 2, section.sectionEnd)).toBe('\n\n');
    expect(result).toBe('<h2>One</h2>\n  <p>body</p>\n\n<p>added</p><h2>Two</h2>\n<p>tail</p>');
  });

  it('the bytes after a replaced span are unchanged, including whitespace before the next heading', () => {
    const result = edit(source, 'One', 'replace', '<p>new</p>');
    expect(result).toBe('<h2>One</h2><p>new</p><h2>Two</h2>\n<p>tail</p>');
  });

  it('supplied leading and trailing whitespace is inserted verbatim', () => {
    const result = edit(source, 'One', 'replace', '\n\t<p>new</p>  \n');
    expect(result).toBe('<h2>One</h2>\n\t<p>new</p>  \n<h2>Two</h2>\n<p>tail</p>');
  });
});

describe('the assembled document is validated, not just the fragment (task 6.8a)', () => {
  // An unterminated declaration is the reachable case: `<!` tokenizes as a complete
  // declaration token with no notice, so the fragment is well-formed ON ITS OWN, and once
  // spliced it swallows the closing tag that follows it.
  const fragment = '<p>a</p><!';

  it('the fragment really is well-formed in isolation', () => {
    expect(isWellFormed(tokenize(fragment))).toBe(true);
  });

  it('but the assembled document is not, and the failure says assembly produced it', () => {
    const source = loadFixture('heading-in-layout-cells');
    const assembled = edit(source, 'Left Two', 'replace', fragment);

    expect(isWellFormed(tokenize(assembled))).toBe(false);
    expect(messageOf(() => assertAssembledWellFormed(assembled))).toContain(
      'assembly produced invalid content'
    );
  });

  it('a valid assembly passes through', () => {
    expect(() =>
      assertAssembledWellFormed(edit(PLAIN, 'Added', 'replace', '<p>ok</p>'))
    ).not.toThrow();
  });
});

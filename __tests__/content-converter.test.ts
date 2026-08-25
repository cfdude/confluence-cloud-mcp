/**
 * Converter behaviour: lists, structure-aware whitespace, block/inline rendering, and text
 * retention. Tasks 3.2, 3.3, 3.4 and 3.5.
 *
 * Task 3.3 is the one with no prior coverage. The global line-joining rule
 * (`.replace(/([^\n])\n([^\n])/g, '$1 $2')` at the old content-converter.ts:~118) collapsed
 * every list onto one line, and task 1.4 pinned only the `$1` half of the observed output
 * `"Deployment steps:\n\n1. $1 2. $1 3. $1"`. The line-structure assertions here are that
 * missing half.
 */

import { describe, it, expect } from '@jest/globals';

import { convertStorageToMarkdown } from '../src/utils/content-converter.js';
import { loadFixture } from './helpers/fixtures.js';

describe('unordered and nested lists (task 3.2)', () => {
  it('puts each unordered item on its own line', () => {
    const markdown = convertStorageToMarkdown('<ul><li>note A</li><li>note B</li></ul>');
    expect(markdown).toBe('* note A\n* note B');
  });

  it('indents nested items relative to their parent item and loses no text', () => {
    const markdown = convertStorageToMarkdown(loadFixture('nested-list'));

    expect(markdown).toBe(
      [
        '* parent one',
        '  * child one A',
        '  * child one B',
        '* parent two',
        '  1. ordered child one',
        '  2. ordered child two',
      ].join('\n')
    );
  });

  it('indents a nested list under an ordered item by the marker width', () => {
    const markdown = convertStorageToMarkdown('<ol><li>outer<ul><li>inner</li></ul></li></ol>');
    // `1. ` is three characters wide, so the nested item aligns under the item text.
    expect(markdown).toBe('1. outer\n   * inner');
  });

  it('honours the start attribute on an ordered list', () => {
    const markdown = convertStorageToMarkdown('<ol start="4"><li>four</li><li>five</li></ol>');
    expect(markdown).toBe('4. four\n5. five');
  });

  it('handles the real-world <li><p>text</p></li> shape without blank lines between items', () => {
    const markdown = convertStorageToMarkdown(
      '<ol><li><p>first</p></li><li><p>second</p></li></ol>'
    );
    expect(markdown).toBe('1. first\n2. second');
  });
});

describe('structure-aware whitespace (task 3.3)', () => {
  it('does not join ordered-list items onto one line', () => {
    const markdown = convertStorageToMarkdown(loadFixture('ordered-list'));

    // The exact defect: the old rule produced "1. ... 2. ... 3. ..." on a single line.
    expect(markdown).toBe(
      'Deployment steps:\n\n1. Open the console\n2. Click Deploy\n3. Verify the rollout'
    );
    expect(markdown.split('\n').filter((line) => /^\d+\. /.test(line))).toHaveLength(3);
  });

  it('does not join unordered-list items onto one line', () => {
    const markdown = convertStorageToMarkdown(loadFixture('plain'));
    expect(markdown).toContain('* note A\n* note B');
    expect(markdown).not.toMatch(/note A .*note B/);
  });

  it('leaves no fixture with two list markers on the same line', () => {
    for (const name of ['ordered-list', 'nested-list', 'plain', 'macro-in-list']) {
      const markdown = convertStorageToMarkdown(loadFixture(name));
      for (const line of markdown.split('\n')) {
        expect(line.trimStart().replace(/^(\* |\d+\. )/, '')).not.toMatch(/(^|\s)(\* |\d+\. )/);
      }
    }
  });

  it('separates blocks with a blank line and collapses source newlines inside a block', () => {
    const markdown = convertStorageToMarkdown('<p>one\ntwo</p>\n<p>three</p>');
    expect(markdown).toBe('one two\n\nthree');
  });

  it('does not turn whitespace between block elements into content', () => {
    const markdown = convertStorageToMarkdown('<h2>Title</h2>\n\n  \n<p>body</p>');
    expect(markdown).toBe('## Title\n\nbody');
  });

  it('keeps a hard break from <br> rather than collapsing it into a space', () => {
    expect(convertStorageToMarkdown('<p>one<br />two</p>')).toBe('one\ntwo');
  });
});

describe('headings, paragraphs, inline markup, links, code and tables (task 3.4)', () => {
  it('renders headings at their source level', () => {
    for (let level = 1; level <= 6; level += 1) {
      const markdown = convertStorageToMarkdown(`<h${level}>Title</h${level}>`);
      expect(markdown).toBe(`${'#'.repeat(level)} Title`);
    }
  });

  it('renders inline emphasis without discarding the surrounding text', () => {
    const markdown = convertStorageToMarkdown(loadFixture('ordered-list-inline-markup'));
    expect(markdown).toBe('1. Run the **Deploy** job\n2. Check the *status* panel');
  });

  it('keeps whitespace outside emphasis markers', () => {
    expect(convertStorageToMarkdown('<p><strong>Deploy </strong>now</p>')).toBe('**Deploy** now');
  });

  it('renders links, inline code and code blocks', () => {
    expect(convertStorageToMarkdown('<p>See <a href="https://example.com/x">docs</a>.</p>')).toBe(
      'See [docs](https://example.com/x).'
    );
    expect(convertStorageToMarkdown('<p>run <code>npm test</code></p>')).toBe('run `npm test`');
    expect(convertStorageToMarkdown('<pre>line one\nline two</pre>')).toBe(
      '```\nline one\nline two\n```'
    );
  });

  it('renders a table with every cell text present', () => {
    const source = loadFixture('table');
    const markdown = convertStorageToMarkdown(source);

    expect(markdown).toBe(
      [
        '| Environment | Region | Owner |',
        '| --- | --- | --- |',
        '| staging | east | platform team |',
        '| production | west | release team |',
      ].join('\n')
    );

    for (const cell of [
      'Environment',
      'Region',
      'Owner',
      'staging',
      'east',
      'platform team',
      'production',
      'west',
      'release team',
    ]) {
      expect(markdown).toContain(cell);
    }
  });

  it('renders block quotes and horizontal rules', () => {
    expect(convertStorageToMarkdown('<blockquote><p>quoted</p></blockquote>')).toBe('> quoted');
    expect(convertStorageToMarkdown('<p>a</p><hr /><p>b</p>')).toBe('a\n\n---\n\nb');
  });

  it('decodes entities in text rather than emitting them raw', () => {
    expect(convertStorageToMarkdown('<p>Ops&rsquo; team &mdash; ready &amp; set</p>')).toBe(
      'Ops’ team — ready & set'
    );
  });
});

describe('text retention for unrecognized elements (task 3.5)', () => {
  it('keeps the text of a non-namespaced element the converter does not model', () => {
    const markdown = convertStorageToMarkdown(loadFixture('unknown-markup'));

    expect(markdown).toContain('Widget summary text');
    expect(markdown).toContain('Before the widget.');
    expect(markdown).toContain('After the widget.');
  });

  it('keeps the text inside an unmodelled macro, parameters included', () => {
    const markdown = convertStorageToMarkdown(loadFixture('unknown-markup'));

    // The macro placeholder is a LABEL, not a substitution: the body still renders.
    expect(markdown).toContain('[Confluence Macro: thirdparty-report');
    expect(markdown).toContain('reportId: R-42');
    expect(markdown).toContain('Report body text');
  });

  it('keeps text from an element with no handler at all', () => {
    expect(convertStorageToMarkdown('<p>a <q>quoted bit</q> b</p>')).toBe('a quoted bit b');
    expect(convertStorageToMarkdown('<x-block><p>inner</p></x-block>')).toBe('inner');
  });

  it('does not raise on malformed markup and still returns the text', () => {
    const markdown = convertStorageToMarkdown('<p>open only<ul><li>item');
    expect(markdown).toContain('open only');
    expect(markdown).toContain('item');
  });
});

import { describe, it, expect } from '@jest/globals';

import {
  collectHeadingOutline,
  foldHeadingText,
  headingOutline,
} from '../src/utils/heading-outline.js';
import { tokenize } from '../src/utils/storage-tokenizer.js';
import { loadFixture } from './helpers/fixtures.js';

describe('headingOutline -- levels and document order (task 4.6)', () => {
  it('lists every heading in document order with its level', () => {
    const outline = headingOutline(loadFixture('plain'));

    expect(outline.map((entry) => [entry.level, entry.text])).toEqual([
      [1, 'Release Notes'],
      [2, 'Added'],
      [2, 'Fixed'],
    ]);
  });

  it('returns an empty outline for a page with no headings', () => {
    expect(headingOutline('<p>just a paragraph</p>')).toEqual([]);
  });

  it('returns an empty outline for empty storage', () => {
    expect(headingOutline('')).toEqual([]);
  });

  it('strips inline markup from heading text', () => {
    const outline = headingOutline('<h3>A <strong>bold</strong> <em>idea</em></h3>');

    expect(outline[0]).toMatchObject({ level: 3, text: 'A bold idea' });
  });

  it('excludes text inside a nested macro, leaving a macro-only heading empty', () => {
    const source =
      '<h2><ac:structured-macro ac:name="status">' +
      '<ac:parameter ac:name="colour">Green</ac:parameter>' +
      '</ac:structured-macro></h2>';

    expect(headingOutline(source)[0].text).toBe('');
  });
});

describe('headingOutline -- duplicate headings (task 4.6)', () => {
  it('lists duplicates separately with distinguishing occurrence indices', () => {
    const outline = headingOutline('<h2>Notes</h2><p>a</p><h2>Notes</h2><p>b</p><h2>Other</h2>');

    expect(outline.map((entry) => [entry.text, entry.occurrence])).toEqual([
      ['Notes', 1],
      ['Notes', 2],
      ['Other', 1],
    ]);
  });

  it('counts occurrences over the fold key, so a typographic variant is the same heading', () => {
    const outline = headingOutline("<h2>Ops&rsquo; plan</h2><h2>Ops' plan</h2>");

    expect(outline.map((entry) => [entry.text, entry.occurrence])).toEqual([
      ['Ops’ plan', 1],
      ["Ops' plan", 2],
    ]);
  });

  it('counts occurrences over ALL headings, addressable or not', () => {
    const source =
      '<h2>Notes</h2>' +
      '<ac:structured-macro ac:name="expand"><ac:rich-text-body>' +
      '<h2>Notes</h2>' +
      '</ac:rich-text-body></ac:structured-macro>' +
      '<h2>Notes</h2>';
    const outline = headingOutline(source);

    expect(outline.map((entry) => [entry.occurrence, entry.addressable])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ]);
  });
});

describe('foldHeadingText -- the matching key section 6 must reuse', () => {
  it('folds curly apostrophes and quotes to straight ones', () => {
    expect(foldHeadingText('Ops’ “plan”')).toBe(`Ops' "plan"`);
  });

  it('collapses whitespace runs, including a decoded non-breaking space', () => {
    expect(foldHeadingText('Release   Notes\n')).toBe('Release Notes');
  });

  it('does NOT fold dashes, so hyphen and en dash stay distinct headings', () => {
    expect(foldHeadingText('Non-Goals')).not.toBe(foldHeadingText('Non–Goals'));
  });

  it('preserves case', () => {
    expect(foldHeadingText('Release Notes')).not.toBe(foldHeadingText('release notes'));
  });

  it('is idempotent', () => {
    const once = foldHeadingText('Ops’  plan');
    expect(foldHeadingText(once)).toBe(once);
  });
});

describe('headingOutline -- addressability (task 4.6, design.md D3)', () => {
  it('flags a heading inside a macro body as not addressable', () => {
    const outline = headingOutline(loadFixture('heading-in-macro-body'));

    expect(outline.map((entry) => [entry.text, entry.addressable])).toEqual([
      ['A', true],
      ['B', false],
      ['C', true],
    ]);
  });

  it('flags a heading inside a table cell as not addressable', () => {
    const outline = headingOutline(loadFixture('heading-in-table-cell'));

    expect(outline.map((entry) => [entry.text, entry.addressable])).toEqual([
      ['Outer', true],
      ['Cell Heading', false],
      ['Next', true],
    ]);
  });

  it('flags a heading inside a layout cell as addressable', () => {
    const outline = headingOutline(loadFixture('heading-in-layout-cells'));

    expect(outline.every((entry) => entry.addressable)).toBe(true);
    expect(outline.map((entry) => entry.text)).toEqual([
      'Left One',
      'Left Two',
      'Right One',
      'Right Two',
    ]);
  });

  it('flags root-level and layout-cell headings alike on the composite shape', () => {
    const outline = headingOutline(loadFixture('composite-root-heading-then-layout'));

    expect(outline.map((entry) => [entry.text, entry.addressable])).toEqual([
      ['Root Section', true],
      ['Cell Left', true],
      ['Cell Right', true],
      ['Second Root Section', true],
    ]);
  });

  it('still lists every heading when none is addressable', () => {
    const source =
      '<ac:structured-macro ac:name="expand"><ac:rich-text-body>' +
      '<h2>Buried One</h2><p>x</p>' +
      '</ac:rich-text-body></ac:structured-macro>' +
      '<table><tbody><tr><td><h3>Buried Two</h3></td></tr></tbody></table>';
    const outline = headingOutline(source);

    expect(outline.map((entry) => [entry.level, entry.text, entry.addressable])).toEqual([
      [2, 'Buried One', false],
      [3, 'Buried Two', false],
    ]);
    expect(outline.some((entry) => entry.addressable)).toBe(false);
  });
});

describe('collectHeadingOutline -- element identity for section resolution', () => {
  it('reports the element index of each heading', () => {
    const source = '<p>x</p><h2>One</h2><h3>Two</h3>';
    const result = tokenize(source);
    const outline = collectHeadingOutline(result);

    for (const entry of outline) {
      expect(result.elements[entry.elementIndex].name).toBe(`h${entry.level}`);
    }
  });
});

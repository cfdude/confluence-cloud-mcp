/**
 * Tasks 1.3 / 1.3a -- the fixture corpus itself is verified here.
 *
 * These assertions are the gate the rest of the change leans on: every later task claims
 * "verified against a fixture", which is only meaningful if the fixture exists, is loadable,
 * is well-formed, actually contains the shape it claims, and (for captured fixtures) carries
 * no real page text.
 */

import { describe, it, expect } from '@jest/globals';

import {
  FIXTURE_DIR,
  checkTagBalance,
  inspectShapes,
  listFixtureFiles,
  loadFixture,
  loadManifest,
  textWords,
  type Shapes,
} from './helpers/fixtures.js';

const manifest = loadManifest();
const files = listFixtureFiles();

describe('fixture corpus', () => {
  it('has a manifest describing exactly the fixture files on disk', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(manifest.fixtures.map((f) => f.file).sort()).toEqual(files);
  });

  it.each(files)('%s is non-empty and tag-balanced', (file) => {
    const storage = loadFixture(file);
    expect(storage.trim().length).toBeGreaterThan(0);

    const balance = checkTagBalance(storage);
    expect({ file, ...balance }).toEqual({
      file,
      balanced: true,
      unclosed: [],
      mismatched: [],
    });
  });
});

describe('fixture sanitization (this repository is public)', () => {
  const captured = manifest.fixtures.filter((f) => f.origin === 'captured');

  it('captured fixtures exist and are marked sanitized', () => {
    expect(captured.length).toBeGreaterThan(0);
    for (const entry of captured) {
      expect(entry.sanitized).toBe(true);
      expect(entry.instance).toBe('onvex');
    }
  });

  // "No real page text" is an unverifiable negative on its own. It is checked positively:
  // the sanitizer is the only path text takes into a captured fixture, and it emits words
  // drawn solely from the published synthetic vocabulary. Any word outside that pool is a
  // sanitizer escape.
  it.each(captured.map((f) => f.file))('%s contains only synthetic vocabulary', (file) => {
    const pool = new Set(manifest.syntheticVocabulary);
    const escaped = [...new Set(textWords(loadFixture(file)))].filter((w) => !pool.has(w));
    expect(escaped).toEqual([]);
  });

  it('no captured fixture references a non-onvex Confluence host', () => {
    for (const entry of captured) {
      const storage = loadFixture(entry.file);
      expect(storage).not.toMatch(/listreports/i);
      expect(storage).not.toMatch(/atlassian\.net/i);
    }
  });
});

describe('required shapes are present in the corpus', () => {
  const shapesByFile = new Map<string, Shapes>(
    files.map((file) => [file, inspectShapes(loadFixture(file))])
  );

  const filesWith = (predicate: (s: Shapes) => boolean): string[] =>
    [...shapesByFile.entries()].filter(([, s]) => predicate(s)).map(([file]) => file);

  // Task 1.3
  const required: Array<[string, (s: Shapes) => boolean]> = [
    ['ordered list', (s) => s.orderedList],
    ['nested list', (s) => s.nestedList],
    ['table', (s) => s.table],
    ['structured macro', (s) => s.structuredMacro],
    ['layout', (s) => s.layout],
    ['macro inside a list item', (s) => s.macroInsideListItem],
    [
      'plain page (no macro, no layout, no table)',
      (s) => !s.structuredMacro && !s.layout && !s.table && s.headingCount > 0,
    ],
    ['unmodelled element', (s) => s.unmodelledElement],
    // Task 1.3a
    ['heading inside ac:rich-text-body', (s) => s.headingInRichTextBody],
    ['heading inside a table cell', (s) => s.headingInTableCell],
    ['heading inside ac:layout-cell', (s) => s.headingInLayoutCell],
    ['every heading inside a layout cell', (s) => s.headingsAllInLayoutCells],
    [
      'root-level heading followed by a layout whose cells contain headings',
      (s) => s.rootHeadingBeforeLayoutWithCellHeadings,
    ],
  ];

  it.each(required)('at least one fixture provides: %s', (_label, predicate) => {
    expect(filesWith(predicate)).not.toEqual([]);
  });

  it('the named special-case fixtures carry the shape their name claims', () => {
    expect(inspectShapes(loadFixture('heading-in-macro-body')).headingInRichTextBody).toBe(true);
    expect(inspectShapes(loadFixture('heading-in-table-cell')).headingInTableCell).toBe(true);
    expect(inspectShapes(loadFixture('heading-in-layout-cells')).headingsAllInLayoutCells).toBe(
      true
    );
    expect(
      inspectShapes(loadFixture('composite-root-heading-then-layout'))
        .rootHeadingBeforeLayoutWithCellHeadings
    ).toBe(true);
    expect(inspectShapes(loadFixture('plain')).structuredMacro).toBe(false);
    expect(inspectShapes(loadFixture('plain')).layout).toBe(false);
  });

  it('resolves the fixture directory (guards against a silently wrong path)', () => {
    expect(FIXTURE_DIR).toMatch(/__tests__\/fixtures$/);
  });
});

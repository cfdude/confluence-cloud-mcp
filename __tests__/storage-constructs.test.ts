/**
 * Construct-inventory tests (task 2.4).
 *
 * The per-fixture expectations below are cross-checked against the fixture sources
 * independently of the inventory code (`rg -o 'ac:structured-macro ac:name="[^"]*"'`), so they
 * pin behaviour rather than snapshotting whatever the implementation happened to produce.
 */

import { collectConstructs, inventoryStorage } from '../src/utils/storage-constructs.js';
import { tokenize } from '../src/utils/storage-tokenizer.js';

import { listFixtureFiles, loadFixture } from './helpers/fixtures.js';

interface Expectation {
  lossy: boolean;
  macros: string[];
  layouts: string[];
  namespaced: string[];
  unknown: string[];
}

const LAYOUT_TRIO = ['ac:layout', 'ac:layout-cell', 'ac:layout-section'];

const EXPECTED: Record<string, Expectation> = {
  'captured-layout-table-macros.xhtml': {
    lossy: true,
    macros: ['anchor', 'expand', 'panel', 'status', 'toc'],
    layouts: LAYOUT_TRIO,
    namespaced: [
      'ac:image',
      'ac:parameter',
      'ac:rich-text-body',
      'ac:task',
      'ac:task-body',
      'ac:task-id',
      'ac:task-list',
      'ac:task-status',
      'ri:url',
    ],
    unknown: [],
  },
  'captured-macro-layout-nested-list.xhtml': {
    lossy: true,
    macros: ['expand', 'panel'],
    layouts: LAYOUT_TRIO,
    namespaced: [
      'ac:image',
      'ac:link',
      'ac:link-body',
      'ac:parameter',
      'ac:rich-text-body',
      'ri:attachment',
      'ri:page',
    ],
    unknown: [],
  },
  'captured-macro-ordered-list.xhtml': {
    lossy: true,
    macros: ['info'],
    layouts: [],
    namespaced: ['ac:emoticon', 'ac:placeholder', 'ac:rich-text-body'],
    unknown: [],
  },
  'composite-root-heading-then-layout.xhtml': {
    lossy: true,
    macros: [],
    layouts: LAYOUT_TRIO,
    namespaced: [],
    unknown: [],
  },
  'heading-in-layout-cells.xhtml': {
    lossy: true,
    macros: ['info'],
    layouts: LAYOUT_TRIO,
    namespaced: ['ac:rich-text-body'],
    unknown: [],
  },
  'heading-in-macro-body.xhtml': {
    lossy: true,
    macros: ['expand'],
    layouts: [],
    namespaced: ['ac:rich-text-body'],
    unknown: [],
  },
  // A plain HTML table carries no macro and no layout, so markdown can render it faithfully.
  'heading-in-table-cell.xhtml': {
    lossy: false,
    macros: [],
    layouts: [],
    namespaced: [],
    unknown: [],
  },
  'heading-subsections.xhtml': {
    lossy: false,
    macros: [],
    layouts: [],
    namespaced: [],
    unknown: [],
  },
  'macro-in-list.xhtml': {
    lossy: true,
    macros: ['info', 'status'],
    layouts: [],
    namespaced: ['ac:parameter', 'ac:rich-text-body'],
    unknown: [],
  },
  'nested-list.xhtml': { lossy: false, macros: [], layouts: [], namespaced: [], unknown: [] },
  'ordered-list-inline-markup.xhtml': {
    lossy: false,
    macros: [],
    layouts: [],
    namespaced: [],
    unknown: [],
  },
  'ordered-list.xhtml': { lossy: false, macros: [], layouts: [], namespaced: [], unknown: [] },
  'plain.xhtml': { lossy: false, macros: [], layouts: [], namespaced: [], unknown: [] },
  'table.xhtml': { lossy: false, macros: [], layouts: [], namespaced: [], unknown: [] },
  'unknown-markup.xhtml': {
    lossy: true,
    macros: ['thirdparty-report'],
    layouts: [],
    namespaced: ['ac:parameter', 'ac:rich-text-body'],
    unknown: ['x-widget'],
  },
};

describe('construct inventory -- per fixture', () => {
  it('has an expectation for every fixture on disk', () => {
    expect(listFixtureFiles().sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.keys(EXPECTED))('%s reports its expected constructs', (file) => {
    const expected = EXPECTED[file];
    const inventory = inventoryStorage(loadFixture(file));
    expect({
      lossy: inventory.lossy,
      macros: inventory.macroNames,
      layouts: inventory.layoutNames,
      namespaced: inventory.namespacedNames,
      unknown: inventory.unknownNames,
    }).toEqual(expected);
  });

  it.each(Object.keys(EXPECTED))('%s: every occurrence carries a usable source span', (file) => {
    const source = loadFixture(file);
    const inventory = inventoryStorage(source);
    for (const occurrence of inventory.occurrences) {
      expect(occurrence.end).toBeGreaterThan(occurrence.start);
      expect(source.slice(occurrence.start).startsWith(`<${occurrence.name}`)).toBe(true);
    }
  });

  it('flags macro-bearing and layout-bearing fixtures lossy and plain ones faithful', () => {
    expect(inventoryStorage(loadFixture('macro-in-list')).lossy).toBe(true);
    expect(inventoryStorage(loadFixture('heading-in-layout-cells')).lossy).toBe(true);
    expect(inventoryStorage(loadFixture('plain')).lossy).toBe(false);
  });
});

describe('construct inventory -- categorisation', () => {
  it('names macros from ac:name and falls back for an unnamed macro', () => {
    const inventory = inventoryStorage(
      '<ac:structured-macro ac:name="info"/><ac:structured-macro/>'
    );
    expect(inventory.macroNames).toEqual(['(unnamed)', 'info']);
    expect(inventory.occurrences.map((o) => o.signature)).toEqual([
      'macro:info',
      'macro:(unnamed)',
    ]);
  });

  it('counts occurrences as a multiset so dropping one of several is detectable', () => {
    const three = inventoryStorage(
      '<ac:structured-macro ac:name="info"/><ac:structured-macro ac:name="info"/>' +
        '<ac:structured-macro ac:name="info"/>'
    );
    const two = inventoryStorage(
      '<ac:structured-macro ac:name="info"/><ac:structured-macro ac:name="info"/>'
    );
    expect(three.counts['macro:info']).toBe(3);
    expect(two.counts['macro:info']).toBe(2);
    expect(three.signatures).toEqual(two.signatures);
  });

  it('separates layouts, other namespaced elements, and unknown third-party markup', () => {
    const inventory = inventoryStorage(
      '<ac:layout><ac:layout-section><ac:layout-cell><ac:task-list><ac:task/></ac:task-list>' +
        '<x-widget/><ri:url ri:value="https://example.com"/></ac:layout-cell>' +
        '</ac:layout-section></ac:layout>'
    );
    expect(inventory.layoutNames).toEqual(LAYOUT_TRIO);
    expect(inventory.namespacedNames).toEqual(['ac:task', 'ac:task-list', 'ri:url']);
    expect(inventory.unknownNames).toEqual(['x-widget']);
    expect(inventory.macroNames).toEqual([]);
  });

  it('records nothing for markup markdown can represent', () => {
    const inventory = inventoryStorage(
      '<h2>H</h2><p><strong>a</strong> <em>b</em> <a href="#">c</a></p>' +
        '<ul><li>x</li></ul><table><tbody><tr><td>cell</td></tr></tbody></table><br/><hr/>'
    );
    expect(inventory.occurrences).toEqual([]);
    expect(inventory.lossy).toBe(false);
  });

  it('does not raise on malformed markup', () => {
    expect(() => inventoryStorage('<ac:structured-macro ac:name="x"><p>unclosed')).not.toThrow();
    expect(inventoryStorage('<ac:structured-macro ac:name="x"><p>unclosed').macroNames).toEqual([
      'x',
    ]);
  });
});

describe('construct inventory -- span scoping', () => {
  const source =
    '<h2>A</h2><ac:structured-macro ac:name="inside"/><h2>B</h2>' +
    '<ac:structured-macro ac:name="outside"/>';

  it('counts only constructs wholly inside the span', () => {
    const result = tokenize(source);
    const spanEnd = source.indexOf('<h2>B</h2>');
    const scoped = collectConstructs(result, { start: 0, end: spanEnd });
    expect(scoped.macroNames).toEqual(['inside']);
    expect(collectConstructs(result).macroNames).toEqual(['inside', 'outside']);
  });

  it('excludes a construct that straddles the span boundary', () => {
    const result = tokenize(source);
    const macroStart = source.indexOf('<ac:structured-macro ac:name="inside"');
    const scoped = collectConstructs(result, { start: 0, end: macroStart + 5 });
    expect(scoped.occurrences).toEqual([]);
    expect(scoped.lossy).toBe(false);
  });

  it('scopes a real fixture to one layout cell', () => {
    const fixture = loadFixture('heading-in-layout-cells');
    const result = tokenize(fixture);
    const cells = result.elements.filter((e) => e.name === 'ac:layout-cell');
    const whole = collectConstructs(result);
    const firstCell = collectConstructs(result, {
      start: cells[0].contentStart,
      end: cells[0].contentEnd,
    });
    expect(whole.layoutNames).toEqual(LAYOUT_TRIO);
    expect(firstCell.layoutNames).toEqual([]);
    expect(firstCell.occurrences.length).toBeLessThan(whole.occurrences.length);
  });
});

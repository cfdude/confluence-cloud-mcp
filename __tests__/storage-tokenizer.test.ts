/**
 * Tokenizer unit tests (tasks 2.1 / 2.3).
 *
 * The offset round-trip suite is the evidence behind the parse5-vs-hand-rolled decision:
 * slicing the original source by each token's reported offsets must reproduce that token's
 * raw text with zero byte differences, on every fixture including the 17 KB captured page.
 */

import {
  ancestorsOf,
  attributeValue,
  blockingAncestorsOf,
  containerKind,
  isAddressable,
  isWellFormed,
  wellFormednessErrors,
  nearestContainerOf,
  tokenize,
  type StorageElement,
  type TokenizeResult,
} from '../src/utils/storage-tokenizer.js';

import { listFixtureFiles, loadFixture } from './helpers/fixtures.js';

const fixtures = listFixtureFiles();

const elementsNamed = (result: TokenizeResult, name: string): StorageElement[] =>
  result.elements.filter((element) => element.name === name);

const headings = (result: TokenizeResult): StorageElement[] =>
  result.elements.filter((element) => /^h[1-6]$/.test(element.name));

const textOf = (result: TokenizeResult, element: StorageElement): string =>
  result.source.slice(element.contentStart, element.contentEnd).replace(/<[^>]*>/g, '');

describe('storage tokenizer -- offset fidelity', () => {
  it('has fixtures to run against', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)('%s: every token raw equals its own source slice', (file) => {
    const source = loadFixture(file);
    const { tokens } = tokenize(source);
    const mismatched = tokens.filter((token) => token.raw !== source.slice(token.start, token.end));
    expect(mismatched).toEqual([]);
  });

  it.each(fixtures)('%s: tokens tile the source with no gaps or overlaps', (file) => {
    const source = loadFixture(file);
    const { tokens } = tokenize(source);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0].start).toBe(0);
    expect(tokens[tokens.length - 1].end).toBe(source.length);
    for (let i = 1; i < tokens.length; i += 1) {
      expect(tokens[i].start).toBe(tokens[i - 1].end);
    }
  });

  it.each(fixtures)('%s: concatenated token raws reproduce the source byte for byte', (file) => {
    const source = loadFixture(file);
    const { tokens } = tokenize(source);
    expect(tokens.map((token) => token.raw).join('')).toBe(source);
  });

  it.each(fixtures)('%s: every element span brackets its own tags', (file) => {
    const source = loadFixture(file);
    const result = tokenize(source);
    for (const element of result.elements) {
      expect(source.slice(element.start, element.start + 1 + element.rawName.length)).toBe(
        `<${element.rawName}`
      );
      expect(element.contentStart).toBeGreaterThanOrEqual(element.start);
      expect(element.contentEnd).toBeGreaterThanOrEqual(element.contentStart);
      expect(element.end).toBeGreaterThanOrEqual(element.contentEnd);
      if (!element.selfClosing && !element.implicitlyClosed) {
        expect(source.slice(element.contentEnd, element.end)).toBe(`</${element.rawName}>`);
      }
    }
  });

  it.each(fixtures)('%s: no fixture produces a malformed-markup notice', (file) => {
    const result = tokenize(loadFixture(file));
    expect(result.notices).toEqual([]);
  });

  it('reports byte-exact offsets on the 17 KB captured page', () => {
    const source = loadFixture('captured-layout-table-macros');
    expect(source.length).toBeGreaterThan(17000);
    const result = tokenize(source);
    expect(result.tokens.length).toBeGreaterThan(500);
    expect(result.tokens.every((t) => t.raw === source.slice(t.start, t.end))).toBe(true);
    expect(result.notices).toEqual([]);
  });
});

describe('storage tokenizer -- namespaced elements', () => {
  it('preserves ac: element names, attribute names, order, and quoting', () => {
    const source =
      '<ac:structured-macro ac:name="info" ac:schema-version="1" ac:macro-id="ABC-123" data-x=\'q\'>' +
      '<ac:parameter ac:name="title">GREEN</ac:parameter></ac:structured-macro>';
    const result = tokenize(source);
    const macro = elementsNamed(result, 'ac:structured-macro')[0];
    expect(macro.prefix).toBe('ac');
    expect(macro.attributes.map((a) => a.name)).toEqual([
      'ac:name',
      'ac:schema-version',
      'ac:macro-id',
      'data-x',
    ]);
    expect(macro.attributes.map((a) => a.quote)).toEqual(['"', '"', '"', "'"]);
    expect(attributeValue(macro, 'ac:name')).toBe('info');
    expect(source.slice(macro.start, macro.end)).toBe(source);
  });

  it('preserves ri: elements and decodes entity-bearing attribute values', () => {
    const source = '<ac:link><ri:page ri:content-title="A &amp; B &#38; C" /></ac:link>';
    const result = tokenize(source);
    const page = elementsNamed(result, 'ri:page')[0];
    expect(page.prefix).toBe('ri');
    expect(page.selfClosing).toBe(true);
    expect(attributeValue(page, 'ri:content-title')).toBe('A & B & C');
    expect(page.attributes[0].rawValue).toBe('A &amp; B &#38; C');
  });

  it('passes unknown non-namespaced elements through uninterpreted', () => {
    const source = loadFixture('unknown-markup');
    const result = tokenize(source);
    const widget = elementsNamed(result, 'x-widget')[0];
    expect(widget).toBeDefined();
    expect(attributeValue(widget, 'data-source')).toBe('feed');
    expect(result.source.slice(widget.contentStart, widget.contentEnd)).toBe('Widget summary text');
    expect(result.notices).toEqual([]);
  });

  it('does not lowercase-mangle mixed-case attribute values', () => {
    const result = tokenize('<AC:Structured-Macro AC:Name="MyMacro"/>');
    const element = result.elements[0];
    expect(element.name).toBe('ac:structured-macro');
    expect(element.rawName).toBe('AC:Structured-Macro');
    expect(element.attributes[0].name).toBe('ac:name');
    expect(element.attributes[0].value).toBe('MyMacro');
  });
});

describe('storage tokenizer -- self-closing tags', () => {
  // This is the case that disqualified parse5: HTML5 ignores the slash on non-void elements,
  // so the following siblings become children and the ancestry is wrong.
  it('does not let a self-closing <p /> swallow its following siblings', () => {
    const source =
      '<ac:layout-cell><p>a</p><p /></ac:layout-cell><ac:layout-cell><p>b</p></ac:layout-cell>';
    const result = tokenize(source);
    const cells = elementsNamed(result, 'ac:layout-cell');
    expect(cells).toHaveLength(2);
    expect(cells[0].parent).toBe(-1);
    expect(cells[1].parent).toBe(-1);
    expect(source.slice(cells[0].start, cells[0].end)).toBe(
      '<ac:layout-cell><p>a</p><p /></ac:layout-cell>'
    );
    expect(source.slice(cells[1].start, cells[1].end)).toBe(
      '<ac:layout-cell><p>b</p></ac:layout-cell>'
    );
    expect(result.notices).toEqual([]);
  });

  it.each([
    ['<ri:page ri:content-title="X" /><p>after</p>', 'ri:page'],
    ['<ac:emoticon ac:name="star" />trailing<h2>H</h2>', 'ac:emoticon'],
    ['<h2>A</h2><x-widget />after<h2>B</h2>', 'x-widget'],
  ])('%s: %s is self-closing and adopts nothing', (source, name) => {
    const result = tokenize(source);
    const element = elementsNamed(result, name)[0];
    expect(element.selfClosing).toBe(true);
    expect(element.contentStart).toBe(element.contentEnd);
    expect(result.elements.filter((e) => e.parent === element.index)).toEqual([]);
  });

  it('treats HTML void elements as self-closing without a slash', () => {
    const result = tokenize('<p>a<br>b<hr>c</p>');
    expect(elementsNamed(result, 'br')[0].selfClosing).toBe(true);
    expect(elementsNamed(result, 'hr')[0].selfClosing).toBe(true);
    expect(elementsNamed(result, 'p')[0].implicitlyClosed).toBe(false);
    expect(result.notices).toEqual([]);
  });
});

describe('storage tokenizer -- malformed markup never throws', () => {
  const malformed: Array<[string, string]> = [
    ['unclosed element', '<ac:structured-macro ac:name="x"><ac:rich-text-body><p>never closed'],
    ['stray close tag', '</p><p>ok</p>'],
    ['close tag mismatch', '<div><h2>A</h2></span><p>after</p></div>'],
    ['bare less-than in prose', '<p>3 < 4 and a<b</p>'],
    ['unterminated tag', '<p>text<ac:structured-macro ac:name="x"'],
    ['unterminated comment', '<p>a</p><!-- never ends'],
    ['unterminated cdata', '<ac:plain-text-body><![CDATA[ unfinished'],
    ['bare markup soup', '< < <<< > > "" />'],
    ['empty input', ''],
    ['text only', 'just some prose with & entities'],
  ];

  it.each(malformed)('%s does not throw and still tiles the source', (_label, source) => {
    let result: TokenizeResult | undefined;
    expect(() => {
      result = tokenize(source);
    }).not.toThrow();
    const tokens = result!.tokens;
    expect(tokens.map((t) => t.raw).join('')).toBe(source);
    for (let i = 1; i < tokens.length; i += 1) {
      expect(tokens[i].start).toBe(tokens[i - 1].end);
    }
  });

  it('closes an unclosed element at end of input and says so', () => {
    const source = '<ac:structured-macro ac:name="x"><ac:rich-text-body><p>never closed';
    const result = tokenize(source);
    const macro = elementsNamed(result, 'ac:structured-macro')[0];
    expect(macro.implicitlyClosed).toBe(true);
    expect(macro.contentEnd).toBe(source.length);
    expect(result.notices.map((n) => n.code)).toContain('unclosed-element-at-eof');
  });

  it('ignores a stray close tag rather than popping the open stack', () => {
    const source = '<div><h2>A</h2></span><p>after</p></div>';
    const result = tokenize(source);
    const div = elementsNamed(result, 'div')[0];
    const paragraph = elementsNamed(result, 'p')[0];
    expect(div.implicitlyClosed).toBe(false);
    expect(paragraph.parent).toBe(div.index);
    expect(result.notices.map((n) => n.code)).toEqual(['unmatched-close-tag']);
  });

  it('implicitly closes elements above a matching close tag', () => {
    const source = '<ac:layout-cell><p>a<em>b</ac:layout-cell>';
    const result = tokenize(source);
    const cell = elementsNamed(result, 'ac:layout-cell')[0];
    const em = elementsNamed(result, 'em')[0];
    expect(cell.implicitlyClosed).toBe(false);
    expect(cell.end).toBe(source.length);
    expect(em.implicitlyClosed).toBe(true);
    expect(em.contentEnd).toBe(source.indexOf('</ac:layout-cell>'));
    expect(result.notices.map((n) => n.code)).toEqual([
      'implicitly-closed-element',
      'implicitly-closed-element',
    ]);
  });

  it('keeps CDATA and comments as single opaque tokens', () => {
    const source = '<ac:plain-text-body><![CDATA[ a < b > c ]]></ac:plain-text-body><!-- x < y -->';
    const result = tokenize(source);
    const cdata = result.tokens.find((t) => t.type === 'cdata');
    const comment = result.tokens.find((t) => t.type === 'comment');
    expect(cdata?.raw).toBe('<![CDATA[ a < b > c ]]>');
    expect(comment?.raw).toBe('<!-- x < y -->');
    expect(result.notices).toEqual([]);
  });

  it('throws only for a non-string input', () => {
    expect(() => tokenize(null as unknown as string)).toThrow(TypeError);
    expect(() => tokenize(undefined as unknown as string)).toThrow(TypeError);
  });
});

describe('storage tokenizer -- ancestry and sectioning containers', () => {
  it('classifies containers per design.md D3', () => {
    expect(containerKind('ac:layout')).toBe('sectioning');
    expect(containerKind('ac:layout-section')).toBe('sectioning');
    expect(containerKind('ac:layout-cell')).toBe('sectioning');
    expect(containerKind('ac:rich-text-body')).toBe('opaque');
    expect(containerKind('ac:structured-macro')).toBe('opaque');
    expect(containerKind('ac:task-body')).toBe('opaque');
    expect(containerKind('ac:plain-text-body')).toBe('opaque');
    expect(containerKind('ri:page')).toBe('opaque');
    expect(containerKind('td')).toBe('opaque');
    expect(containerKind('th')).toBe('opaque');
    expect(containerKind('p')).toBe('transparent');
    expect(containerKind('div')).toBe('transparent');
    expect(containerKind('table')).toBe('transparent');
  });

  it('reports the document root when a heading has no container', () => {
    const result = tokenize(loadFixture('plain'));
    const heading = headings(result)[0];
    const container = nearestContainerOf(result, heading.index);
    expect(container).toMatchObject({ index: -1, kind: 'root', contentStart: 0 });
    expect(container.contentEnd).toBe(result.source.length);
    expect(isAddressable(result, heading.index)).toBe(true);
  });

  it('reports the layout cell for a heading inside one, and marks it addressable', () => {
    const result = tokenize(loadFixture('heading-in-layout-cells'));
    const found = headings(result);
    expect(found.length).toBeGreaterThan(0);
    for (const heading of found) {
      const container = nearestContainerOf(result, heading.index);
      expect(container.kind).toBe('sectioning');
      expect(container.name).toBe('ac:layout-cell');
      expect(isAddressable(result, heading.index)).toBe(true);
      expect(heading.start).toBeGreaterThanOrEqual(container.contentStart);
      expect(heading.end).toBeLessThanOrEqual(container.contentEnd);
    }
    // Two cells, each owning its own headings.
    const cells = elementsNamed(result, 'ac:layout-cell');
    expect(cells.length).toBeGreaterThanOrEqual(2);
    const owners = new Set(found.map((h) => nearestContainerOf(result, h.index).index));
    expect(owners.size).toBeGreaterThanOrEqual(2);
  });

  it('reports the macro body for a heading inside one, and marks it NOT addressable', () => {
    const result = tokenize(loadFixture('heading-in-macro-body'));
    const byText = new Map(headings(result).map((h) => [textOf(result, h).trim(), h]));
    const nested = byText.get('B')!;
    expect(nested).toBeDefined();
    const container = nearestContainerOf(result, nested.index);
    expect(container.kind).toBe('opaque');
    expect(container.name).toBe('ac:rich-text-body');
    expect(isAddressable(result, nested.index)).toBe(false);
    expect(blockingAncestorsOf(result, nested.index).map((e) => e.name)).toEqual([
      'ac:structured-macro',
      'ac:rich-text-body',
    ]);
    // Its root-level siblings stay addressable and keep the document as their container.
    for (const text of ['A', 'C']) {
      const heading = byText.get(text)!;
      expect(nearestContainerOf(result, heading.index).kind).toBe('root');
      expect(isAddressable(result, heading.index)).toBe(true);
    }
  });

  it('marks a heading inside a table cell NOT addressable', () => {
    const result = tokenize(loadFixture('heading-in-table-cell'));
    const byText = new Map(headings(result).map((h) => [textOf(result, h).trim(), h]));
    const nested = byText.get('Cell Heading')!;
    expect(nested).toBeDefined();
    const container = nearestContainerOf(result, nested.index);
    expect(container.kind).toBe('opaque');
    expect(container.name).toBe('td');
    expect(isAddressable(result, nested.index)).toBe(false);
    expect(nearestContainerOf(result, byText.get('Outer')!.index).kind).toBe('root');
    expect(isAddressable(result, byText.get('Outer')!.index)).toBe(true);
  });

  it('applies the nearest-container rule, not transitive containment', () => {
    const result = tokenize(loadFixture('composite-root-heading-then-layout'));
    const byText = new Map(headings(result).map((h) => [textOf(result, h).trim(), h]));
    const root = byText.get('Root Section')!;
    const cell = byText.get('Cell Left')!;
    expect(root).toBeDefined();
    expect(cell).toBeDefined();
    expect(nearestContainerOf(result, root.index).kind).toBe('root');
    expect(nearestContainerOf(result, cell.index).name).toBe('ac:layout-cell');
    // The root heading's container is the document; the cell heading's is the cell -- so the
    // cell headings are invisible when computing the root section's extent.
    expect(nearestContainerOf(result, root.index).index).not.toBe(
      nearestContainerOf(result, cell.index).index
    );
  });

  it('exposes container content offsets so a section can stop at its container end', () => {
    const source = loadFixture('heading-in-layout-cells');
    const result = tokenize(source);
    const cell = elementsNamed(result, 'ac:layout-cell')[0];
    expect(source.slice(cell.contentEnd, cell.end)).toBe('</ac:layout-cell>');
    expect(source.slice(cell.start, cell.contentStart)).toMatch(/^<ac:layout-cell[^>]*>$/);
  });

  it('gives every element an ancestor chain consistent with source nesting', () => {
    const source = loadFixture('captured-macro-layout-nested-list');
    const result = tokenize(source);
    for (const element of result.elements) {
      for (const ancestor of ancestorsOf(result, element.index)) {
        expect(element.start).toBeGreaterThanOrEqual(ancestor.contentStart);
        expect(element.end).toBeLessThanOrEqual(ancestor.contentEnd);
      }
    }
  });

  it.each(fixtures)('%s: nearest container always encloses the element', (file) => {
    const result = tokenize(loadFixture(file));
    for (const element of result.elements) {
      const container = nearestContainerOf(result, element.index);
      expect(element.start).toBeGreaterThanOrEqual(container.contentStart);
      expect(element.end).toBeLessThanOrEqual(container.contentEnd);
    }
  });
});

describe('storage tokenizer -- well-formedness predicate', () => {
  it.each(fixtures)('%s is well-formed', (file) => {
    expect(isWellFormed(tokenize(loadFixture(file)))).toBe(true);
  });

  it('does NOT treat a bare less-than in prose as malformed', () => {
    const result = tokenize('<p>3 < 4 &amp; 5 > 2</p>');
    expect(result.notices.map((n) => n.code)).toEqual(['stray-less-than']);
    expect(wellFormednessErrors(result)).toEqual([]);
    expect(isWellFormed(result)).toBe(true);
  });

  it.each([
    ['unclosed element', '<ac:rich-text-body><p>never closed'],
    ['stray close tag', '<p>a</p></div>'],
    ['implicit close', '<ac:layout-cell><p>a<em>b</ac:layout-cell>'],
    ['unterminated tag', '<p>text<ac:structured-macro ac:name="x"'],
    ['unterminated comment', '<p>a</p><!-- never ends'],
    ['unterminated cdata', '<ac:plain-text-body><![CDATA[ unfinished'],
  ])('%s is malformed', (_label, source) => {
    const result = tokenize(source);
    expect(isWellFormed(result)).toBe(false);
    expect(wellFormednessErrors(result).length).toBeGreaterThan(0);
  });
});

describe('storage tokenizer -- addressability is D3 taken literally', () => {
  // Pinned deliberately: a transparent ancestor blocks addressability. Relaxing this is a
  // section-6 decision that needs its own fixture, not an accident.
  it('does not treat a heading inside a plain <div> as addressable', () => {
    const result = tokenize('<div><h2>A</h2><p>x</p></div><h2>B</h2>');
    const [inDiv, atRoot] = headings(result);
    expect(containerKind('div')).toBe('transparent');
    expect(nearestContainerOf(result, inDiv.index).kind).toBe('root');
    expect(isAddressable(result, inDiv.index)).toBe(false);
    expect(blockingAncestorsOf(result, inDiv.index).map((e) => e.name)).toEqual(['div']);
    expect(isAddressable(result, atRoot.index)).toBe(true);
  });

  it('does not treat a heading inside a <blockquote> as addressable', () => {
    const result = tokenize('<blockquote><h3>Quoted</h3></blockquote>');
    expect(isAddressable(result, headings(result)[0].index)).toBe(false);
  });

  it('keeps a heading nested in layout containers addressable at any depth', () => {
    const result = tokenize(
      '<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell><h2>A</h2>' +
        '</ac:layout-cell></ac:layout-section></ac:layout>'
    );
    const heading = headings(result)[0];
    expect(ancestorsOf(result, heading.index).map((e) => e.name)).toEqual([
      'ac:layout',
      'ac:layout-section',
      'ac:layout-cell',
    ]);
    expect(isAddressable(result, heading.index)).toBe(true);
  });
});

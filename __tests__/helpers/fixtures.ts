/**
 * Fixture loading and structural inspection for the content-format-round-trip fixtures.
 *
 * The scanner here is deliberately INDEPENDENT of `scripts/capture-fixtures.mjs`: the script
 * produces the fixtures, so reusing its scanner to verify them would make the check circular.
 * It is also deliberately small -- task 2 owns the real tokenizer decision, and nothing in
 * this file should pre-empt it.
 *
 * Storage format is an XHTML *fragment*: no single root element, no namespace declarations
 * for `ac:`/`ri:`. A strict XML parse fails on every legitimate fixture, so well-formedness
 * is checked here as tag balance and nesting.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_DIR = join(process.cwd(), '__tests__', 'fixtures');

export interface FixtureManifestEntry {
  file: string;
  origin: 'captured' | 'hand-authored';
  instance?: string;
  sourcePageId?: string;
  shape: string;
  sanitized: boolean;
}

export interface FixtureManifest {
  sanitizerVersion: number;
  fixtures: FixtureManifestEntry[];
  syntheticVocabulary: string[];
}

export function loadManifest(): FixtureManifest {
  const path = join(FIXTURE_DIR, 'manifest.json');
  if (!existsSync(path)) {
    throw new Error(`fixture manifest missing at ${path} (cwd=${process.cwd()})`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureManifest;
}

export function loadFixture(name: string): string {
  const file = name.endsWith('.xhtml') ? name : `${name}.xhtml`;
  const path = join(FIXTURE_DIR, file);
  if (!existsSync(path)) {
    throw new Error(`fixture not found: ${path} (cwd=${process.cwd()})`);
  }
  return readFileSync(path, 'utf8');
}

export function listFixtureFiles(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.xhtml'))
    .sort();
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export type Token =
  | { type: 'text'; raw: string }
  | { type: 'comment' | 'cdata' | 'decl'; raw: string }
  | { type: 'tag'; raw: string; name: string; kind: 'open' | 'close' | 'self' };

const VOID_ELEMENTS = new Set(['br', 'hr', 'img', 'col', 'input', 'meta', 'link']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const LAYOUT_ELEMENTS = new Set(['ac:layout', 'ac:layout-section', 'ac:layout-cell']);

export function scan(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let textStart = 0;

  const flushText = (end: number): void => {
    if (end > textStart) tokens.push({ type: 'text', raw: input.slice(textStart, end) });
  };

  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) break;

    const literal = (open: string, close: string, type: 'comment' | 'cdata'): boolean => {
      if (!input.startsWith(open, lt)) return false;
      const end = input.indexOf(close, lt + open.length);
      const stop = end === -1 ? input.length : end + close.length;
      flushText(lt);
      tokens.push({ type, raw: input.slice(lt, stop) });
      i = textStart = stop;
      return true;
    };

    if (literal('<!--', '-->', 'comment')) continue;
    if (literal('<![CDATA[', ']]>', 'cdata')) continue;

    if (input.startsWith('<?', lt) || input.startsWith('<!', lt)) {
      const end = input.indexOf('>', lt);
      const stop = end === -1 ? input.length : end + 1;
      flushText(lt);
      tokens.push({ type: 'decl', raw: input.slice(lt, stop) });
      i = textStart = stop;
      continue;
    }

    const nameMatch = /^<\/?([A-Za-z][\w:.-]*)/.exec(input.slice(lt, lt + 128));
    if (!nameMatch) {
      i = lt + 1; // a bare '<' inside text
      continue;
    }

    let j = lt + 1;
    let quote: string | null = null;
    while (j < input.length) {
      const ch = input[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j += 1;
    }
    const stop = Math.min(j + 1, input.length);
    const raw = input.slice(lt, stop);
    flushText(lt);
    tokens.push({
      type: 'tag',
      raw,
      name: nameMatch[1].toLowerCase(),
      kind: raw.startsWith('</') ? 'close' : raw.endsWith('/>') ? 'self' : 'open',
    });
    i = textStart = stop;
  }
  flushText(input.length);
  return tokens;
}

export interface BalanceResult {
  balanced: boolean;
  unclosed: string[];
  /** Closing tags that did not match the element currently open. */
  mismatched: string[];
}

export function checkTagBalance(storage: string): BalanceResult {
  const stack: string[] = [];
  const mismatched: string[] = [];
  for (const token of scan(storage)) {
    if (token.type !== 'tag') continue;
    if (token.kind === 'self' || VOID_ELEMENTS.has(token.name)) continue;
    if (token.kind === 'open') {
      stack.push(token.name);
    } else if (stack[stack.length - 1] === token.name) {
      stack.pop();
    } else {
      mismatched.push(token.name);
    }
  }
  return { balanced: stack.length === 0 && mismatched.length === 0, unclosed: stack, mismatched };
}

export interface Shapes {
  orderedList: boolean;
  unorderedList: boolean;
  nestedList: boolean;
  table: boolean;
  structuredMacro: boolean;
  layout: boolean;
  macroInsideListItem: boolean;
  headingInRichTextBody: boolean;
  headingInTableCell: boolean;
  headingInLayoutCell: boolean;
  headingsAllInLayoutCells: boolean;
  rootHeadingBeforeLayoutWithCellHeadings: boolean;
  unmodelledElement: boolean;
  headingCount: number;
}

/**
 * Elements this server models.
 *
 * `unmodelledElement` means a NON-NAMESPACED element the converter has no handling for
 * (`<x-widget>`). `ac:`/`ri:` elements are excluded because they are namespaced-but-known-
 * shaped: the server does not model their MEANING either, but it recognizes them as
 * Confluence constructs and they are already covered by the macro/layout shape flags.
 * Tasks 3.5 and 6.11 -- "an element the converter does not model" -- are served by BOTH:
 * unknown-markup.xhtml carries `<x-widget>` and a third-party `ac:structured-macro`.
 */
const MODELLED = new Set([
  'p',
  'br',
  'hr',
  'strong',
  'em',
  'b',
  'i',
  'u',
  'code',
  'pre',
  'a',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'span',
  'div',
  'img',
  'time',
  'sub',
  'sup',
  'blockquote',
  'colgroup',
  'col',
  ...HEADINGS,
]);

export function inspectShapes(storage: string): Shapes {
  const stack: string[] = [];
  const shapes: Shapes = {
    orderedList: false,
    unorderedList: false,
    nestedList: false,
    table: false,
    structuredMacro: false,
    layout: false,
    macroInsideListItem: false,
    headingInRichTextBody: false,
    headingInTableCell: false,
    headingInLayoutCell: false,
    headingsAllInLayoutCells: false,
    rootHeadingBeforeLayoutWithCellHeadings: false,
    unmodelledElement: false,
    headingCount: 0,
  };
  let headingsInLayoutCells = 0;
  let sawRootHeading = false;
  let layoutDepth = 0;
  let headingInsideThisLayout = false;

  for (const token of scan(storage)) {
    if (token.type !== 'tag') continue;
    const name = token.name;

    if (token.kind === 'close') {
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k] === name) {
          stack.length = k;
          break;
        }
      }
      if (name === 'ac:layout') {
        layoutDepth -= 1;
        if (layoutDepth === 0 && sawRootHeading && headingInsideThisLayout) {
          shapes.rootHeadingBeforeLayoutWithCellHeadings = true;
        }
      }
      continue;
    }

    const inside = (tag: string): boolean => stack.includes(tag);
    const insideAny = (tags: Set<string>): boolean => stack.some((t) => tags.has(t));

    if (name === 'ol') shapes.orderedList = true;
    if (name === 'ul') shapes.unorderedList = true;
    if ((name === 'ol' || name === 'ul') && inside('li')) shapes.nestedList = true;
    if (name === 'table') shapes.table = true;
    if (name === 'ac:structured-macro') {
      shapes.structuredMacro = true;
      if (inside('li')) shapes.macroInsideListItem = true;
    }
    if (name === 'ac:layout') {
      shapes.layout = true;
      layoutDepth += 1;
      headingInsideThisLayout = false;
    }
    if (!MODELLED.has(name) && !name.startsWith('ac:') && !name.startsWith('ri:')) {
      shapes.unmodelledElement = true;
    }

    if (HEADINGS.has(name)) {
      shapes.headingCount += 1;
      if (inside('ac:rich-text-body')) shapes.headingInRichTextBody = true;
      if (inside('td') || inside('th')) shapes.headingInTableCell = true;
      if (inside('ac:layout-cell')) {
        shapes.headingInLayoutCell = true;
        headingsInLayoutCells += 1;
      }
      if (layoutDepth > 0) headingInsideThisLayout = true;
      if (
        !insideAny(LAYOUT_ELEMENTS) &&
        !inside('ac:rich-text-body') &&
        !inside('td') &&
        !inside('th')
      ) {
        sawRootHeading = true;
      }
    }

    if (token.kind === 'open' && !VOID_ELEMENTS.has(name)) stack.push(name);
  }

  shapes.headingsAllInLayoutCells =
    shapes.headingCount > 0 && headingsInLayoutCells === shapes.headingCount;
  return shapes;
}

/** Alphabetic words appearing in text nodes, with entity references excluded. */
export function textWords(storage: string): string[] {
  const words: string[] = [];
  for (const token of scan(storage)) {
    if (token.type !== 'text' && token.type !== 'cdata') continue;
    const stripped = token.raw.replace(/&#?\w+;/g, ' ');
    for (const word of stripped.match(/[A-Za-z]+/g) ?? []) words.push(word.toLowerCase());
  }
  return words;
}

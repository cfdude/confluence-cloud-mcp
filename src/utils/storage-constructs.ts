/**
 * Construct inventory over the storage token stream (design.md D4).
 *
 * Markdown cannot faithfully represent Confluence macros, layouts, or third-party markup.
 * This module collects what a page actually contains so the read path can disclose that its
 * markdown is lossy (D4) and the write path can detect a submission that dropped a construct
 * the current page has (D6 -- construct-loss preflight).
 *
 * Deliberately conservative, per D4: ANY unrecognized namespaced element marks the render
 * lossy. Over-reporting costs an agent one extra `format: 'storage'` read; under-reporting
 * costs a destroyed page.
 */

import {
  SECTIONING_CONTAINERS,
  attributeValue,
  tokenize,
  type StorageElement,
  type TokenizeResult,
} from './storage-tokenizer.js';

/**
 * Elements this server models in markdown. Anything outside this set, and outside the
 * `ac:`/`ri:` namespaces, is third-party markup we render only as text.
 *
 * This set is a PROMISE the markdown renderer has to keep. If `content-converter.ts` were to
 * drop an element named here, `unknownNames` would under-report it and `lossy` would claim
 * "faithful" for a page that lost content. The two are therefore reconciled rather than
 * independently maintained: the converter exports `reconcileModelledElements()`, which
 * asserts set equality in both directions, and the test suite fails on any drift.
 */
export const MODELLED_ELEMENTS: ReadonlySet<string> = new Set([
  'a',
  'b',
  'big',
  'blockquote',
  'br',
  'caption',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'u',
  'ul',
]);

/** Elements that wrap a macro. The `ac:name` attribute carries the macro's identity. */
const MACRO_ELEMENTS: ReadonlySet<string> = new Set([
  'ac:structured-macro',
  'ac:macro',
  'ac:adf-extension',
]);

export type ConstructCategory = 'macro' | 'layout' | 'namespaced' | 'unknown';

export interface ConstructOccurrence {
  /** Index into `TokenizeResult.elements`. */
  elementIndex: number;
  /** Element name, lowercased, namespace prefix retained. */
  name: string;
  category: ConstructCategory;
  /** For macros: the `ac:name` value, or `'(unnamed)'` when the attribute is absent. */
  macroName?: string;
  /** Stable identity used to compare inventories across a write (`macro:info`). */
  signature: string;
  /** Offset of `<` on the opening tag. */
  start: number;
  /** Offset just past `>` of the closing tag. */
  end: number;
}

export interface ConstructInventory {
  occurrences: ConstructOccurrence[];
  /** Sorted unique macro names. */
  macroNames: string[];
  /** Sorted unique layout element names. */
  layoutNames: string[];
  /** Sorted unique names of other namespaced elements. */
  namespacedNames: string[];
  /** Sorted unique names of non-namespaced elements this server does not model. */
  unknownNames: string[];
  /** Occurrence count per signature -- a multiset, so dropping one of three is detectable. */
  counts: Record<string, number>;
  /** Sorted unique signatures. */
  signatures: string[];
  /** True when the source contains anything markdown cannot faithfully represent. */
  lossy: boolean;
}

export interface ConstructSpan {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

function categorize(element: StorageElement): ConstructCategory | null {
  const { name } = element;
  if (MACRO_ELEMENTS.has(name)) return 'macro';
  if (SECTIONING_CONTAINERS.has(name)) return 'layout';
  if (name.startsWith('ac:') || name.startsWith('ri:')) return 'namespaced';
  if (!MODELLED_ELEMENTS.has(name)) return 'unknown';
  return null;
}

/**
 * Inventory the constructs in a tokenized document, optionally restricted to a source span.
 *
 * Span scoping serves D6's per-span construct-loss check for section edits: an element counts
 * only when it lies wholly inside `span`.
 */
export function collectConstructs(
  result: TokenizeResult,
  span?: ConstructSpan
): ConstructInventory {
  const occurrences: ConstructOccurrence[] = [];
  const counts: Record<string, number> = {};
  const byCategory: Record<ConstructCategory, Set<string>> = {
    macro: new Set(),
    layout: new Set(),
    namespaced: new Set(),
    unknown: new Set(),
  };

  for (const element of result.elements) {
    if (span && (element.start < span.start || element.end > span.end)) continue;
    const category = categorize(element);
    if (!category) continue;

    const macroName =
      category === 'macro' ? (attributeValue(element, 'ac:name') ?? '(unnamed)') : undefined;
    const signature =
      category === 'macro'
        ? `macro:${macroName}`
        : `${category === 'layout' ? 'layout' : 'element'}:${element.name}`;

    byCategory[category].add(category === 'macro' ? macroName! : element.name);
    counts[signature] = (counts[signature] ?? 0) + 1;
    occurrences.push({
      elementIndex: element.index,
      name: element.name,
      category,
      ...(macroName === undefined ? {} : { macroName }),
      signature,
      start: element.start,
      end: element.end,
    });
  }

  const sorted = (set: Set<string>): string[] => [...set].sort();

  return {
    occurrences,
    macroNames: sorted(byCategory.macro),
    layoutNames: sorted(byCategory.layout),
    namespacedNames: sorted(byCategory.namespaced),
    unknownNames: sorted(byCategory.unknown),
    counts,
    signatures: Object.keys(counts).sort(),
    lossy: occurrences.length > 0,
  };
}

/** Convenience: tokenize and inventory in one call. */
export function inventoryStorage(source: string, span?: ConstructSpan): ConstructInventory {
  return collectConstructs(tokenize(source), span);
}

/**
 * Heading outline over the storage token stream (spec: page-content-retrieval --
 * "Retrieval exposes the page's section structure").
 *
 * Retrieval reports every heading on a page in document order with its level, an occurrence
 * index that distinguishes duplicates, and a flag stating whether section editing can address
 * it. The outline NEVER goes empty because nothing is addressable -- a page whose every
 * heading sits inside a macro body or a table cell still lists them, all flagged
 * `addressable: false`, which is how a caller determines section editing is unavailable
 * before attempting it.
 *
 * Addressability is NOT reimplemented here. It is `isAddressable()` from the tokenizer, which
 * encodes design.md D3's asymmetric container rule (layouts are sectioning containers; macro
 * interiors and table cells are opaque).
 */

import {
  decodeEntities,
  isAddressable,
  tokenize,
  type StorageElement,
  type TokenizeResult,
} from './storage-tokenizer.js';

const HEADING_NAMES: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

export interface HeadingEntry {
  /** 1--6, from the element name. */
  level: number;
  /**
   * The heading's visible text: entity-decoded, whitespace-collapsed, trimmed. Text inside a
   * nested `ac:`/`ri:` element is excluded (see {@link headingText}).
   */
  text: string;
  /**
   * 1-based index among the headings on this page sharing the same {@link foldHeadingText}
   * key, in document order. Counted over ALL headings, addressable or not, so the index a
   * caller reads off the outline is the index it supplies back.
   */
  occurrence: number;
  /** True when section editing can address this heading (design.md D3). */
  addressable: boolean;
  /** Index into `TokenizeResult.elements`. Internal; not part of the retrieval response. */
  elementIndex: number;
}

/**
 * The matching key for heading text -- the SINGLE function that defines when two heading
 * strings are "the same heading".
 *
 * `HeadingEntry.occurrence` is computed over this key, so section 6's heading resolution MUST
 * match with this exact function. A looser or tighter fold at resolution time changes the
 * equivalence classes and the occurrence indices stop lining up, which resolves to the wrong
 * section silently.
 *
 * The fold is deliberately narrow:
 *
 * - **NFC**, not NFKC. Compatibility mappings buy nothing for heading text and can merge text
 *   a reader sees as distinct.
 * - **Curly quotes and apostrophes fold to straight ones.** Section 3 taught the tokenizer the
 *   typographic named entities, so `<h2>Ops&rsquo; plan</h2>` now decodes to `Ops’ plan`. A
 *   caller typing `Ops' plan` must still find it.
 * - **Whitespace runs collapse to one space, then trim.** JavaScript's `\s` covers the
 *   non-breaking space `&nbsp;` decodes to.
 * - **Dashes and ellipses are NOT folded.** `Q1-Q2` and `Q1—Q2`, `Non-Goals` and `Non–Goals`
 *   are distinct headings; merging them would turn a unique heading into one that requires an
 *   occurrence index.
 * - **Case is preserved.** Case carries meaning in headings, and folding it could make two
 *   genuinely distinct headings ambiguous. A case-insensitive *fallback* (try the exact fold,
 *   then a lowercased one only if the exact fold found nothing) is the natural extension for
 *   section 6, and it must be a fallback rather than a replacement so occurrence indices keep
 *   their meaning.
 */
export function foldHeadingText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[‘’‛ʼ′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a token sits inside an `ac:`/`ri:` element nested within the heading.
 *
 * Macro interiors are opaque per the Non-Goals, so a status macro's parameter values are not
 * part of the heading's text. A heading whose entire content is a macro therefore has text
 * `''` -- deliberate, and it means section editing cannot reach that heading by text.
 */
function insideNamespacedChild(
  result: TokenizeResult,
  tokenParent: number,
  headingIndex: number
): boolean {
  let current = tokenParent;
  while (current !== -1 && current !== headingIndex) {
    const element = result.elements[current];
    if (!element) return false;
    if (element.prefix !== null) return true;
    current = element.parent;
  }
  return false;
}

function cdataText(raw: string): string {
  const body = raw.startsWith('<![CDATA[') ? raw.slice(9) : raw;
  return body.endsWith(']]>') ? body.slice(0, -3) : body;
}

/** A heading's visible text: entity-decoded, whitespace-collapsed, trimmed. */
function headingText(result: TokenizeResult, element: StorageElement): string {
  const from = element.openTokenIndex + 1;
  const to = element.closeTokenIndex === -1 ? result.tokens.length : element.closeTokenIndex;
  const parts: string[] = [];

  for (let i = from; i < to; i += 1) {
    const token = result.tokens[i];
    if (!token || token.start >= element.contentEnd) break;
    if (token.type !== 'text' && token.type !== 'cdata') continue;
    if (insideNamespacedChild(result, token.parentElement, element.index)) continue;
    parts.push(token.type === 'cdata' ? cdataText(token.raw) : decodeEntities(token.raw));
  }

  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** Every heading in a tokenized document, in document order. */
export function collectHeadingOutline(result: TokenizeResult): HeadingEntry[] {
  const entries: HeadingEntry[] = [];
  const occurrences = new Map<string, number>();

  for (const element of result.elements) {
    if (!HEADING_NAMES.has(element.name)) continue;

    const text = headingText(result, element);
    const key = foldHeadingText(text);
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);

    entries.push({
      level: Number(element.name.slice(1)),
      text,
      occurrence,
      addressable: isAddressable(result, element.index),
      elementIndex: element.index,
    });
  }

  return entries;
}

/** Convenience: tokenize and outline in one call. */
export function headingOutline(source: string): HeadingEntry[] {
  return collectHeadingOutline(tokenize(source));
}

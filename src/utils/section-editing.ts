/**
 * Section resolution and offset splicing (spec: page-section-editing; design.md D3, D6, D9).
 *
 * This is the edit pipeline of D1: it never parses-and-re-serializes. It computes three
 * offsets into the ORIGINAL storage string and produces
 * `source.slice(0, spanStart) + fragment + source.slice(spanEnd)`. Nothing outside
 * `spanStart..spanEnd` is examined, normalized, or re-indented, which is what makes the
 * byte-for-byte guarantee hold for macros and third-party markup this server has never seen.
 *
 * THREE offsets, not two (D3). `bodyStart` is `StorageElement.end` -- just past `>` of the
 * heading's CLOSING tag -- and emphatically NOT `contentEnd`, which is the offset of `<` on
 * that closing tag. Replacing from `contentEnd` would swallow `</h2>` and orphan it; replacing
 * from `headingStart` would delete the heading the spec guarantees survives.
 *
 * THE INVARIANT THAT MAKES THE SPLICE SAFE. A heading is addressable only when every ancestor
 * up to the document root is a sectioning container (`isAddressable`, taken literally). That
 * is equivalent to saying an addressable heading is a DIRECT CHILD of its nearest sectioning
 * container, so both `headingStart` and `bodyStart` are valid sibling positions inside that
 * container, and so is `sectionEnd` (the next such heading's start, or the container's own
 * `contentEnd`). Relaxing addressability to "no OPAQUE ancestor" would break exactly this: a
 * heading inside a root-level `<div>` has the document root as its nearest container, so its
 * `sectionEnd` would be computed among root-level headings OUTSIDE the div and the splice
 * would cross `</div>`. The literal rule is therefore load-bearing, not merely conservative.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { collectHeadingOutline, foldHeadingText, type HeadingEntry } from './heading-outline.js';
import {
  blockingAncestorsOf,
  isWellFormed,
  nearestContainerOf,
  tokenize,
  type ContainerRef,
  type TokenizeResult,
} from './storage-tokenizer.js';
import { assertWellFormed } from './write-safety.js';

/** The operations D3 assigns spans to. */
export type SectionOperation = 'replace' | 'append' | 'insert-after';

export interface SectionSpan {
  /** Inclusive start offset into the page's storage. */
  start: number;
  /** Exclusive end offset. Equal to `start` for an insertion. */
  end: number;
}

export interface ResolvedSection {
  /** 1--6. */
  level: number;
  /** The heading's text as the outline reports it. */
  text: string;
  /** The occurrence index this resolution selected. */
  occurrence: number;
  /** Start of the heading's opening tag. */
  headingStart: number;
  /** End of the heading's closing tag -- the start of the section body. */
  bodyStart: number;
  /**
   * `headingStart` of the next addressable heading at the same or higher level sharing this
   * heading's nearest sectioning container, or that container's `contentEnd`.
   */
  sectionEnd: number;
  /** The nearest sectioning container, or the document root. */
  container: ContainerRef;
  /** Index into `TokenizeResult.elements`. */
  elementIndex: number;
}

export interface SectionRequest {
  heading: string;
  /** 1-based, as reported by the retrieval outline. */
  occurrence?: number;
}

const NOT_MODIFIED = 'The page was not modified.';

const MAX_LISTED_HEADINGS = 30;

function describe(entry: HeadingEntry): string {
  return `${JSON.stringify(entry.text)} (h${entry.level}, occurrence ${entry.occurrence})`;
}

function listHeadings(entries: HeadingEntry[]): string {
  if (entries.length === 0) return 'none';
  const shown = entries.slice(0, MAX_LISTED_HEADINGS).map(describe).join('; ');
  return entries.length > MAX_LISTED_HEADINGS
    ? `${shown} (+${entries.length - MAX_LISTED_HEADINGS} more)`
    : shown;
}

function invalid(message: string): McpError {
  return new McpError(ErrorCode.InvalidParams, message);
}

/**
 * Reject a page whose STORED content is already malformed, before any offset is trusted.
 *
 * Deliberate policy, stated once here. Offsets taken from a document the tokenizer had to
 * repair -- an element it implicitly closed, an unterminated tag -- are not trustworthy, and
 * splicing on untrustworthy offsets is the exact class of damage this change removes. The
 * post-splice check (task 6.8a) would reject nearly all of these anyway, since the same
 * defect survives into the assembled document; failing here instead turns a confusing
 * "assembly produced invalid content" into an accurate diagnosis. Whole-page
 * `update_confluence_page` remains available as the escape hatch.
 */
export function assertCurrentContentUsable(result: TokenizeResult): void {
  if (isWellFormed(result)) return;
  const detail = result.notices
    .slice(0, 3)
    .map((notice) => `${notice.message} (offset ${notice.start})`)
    .join('; ');
  throw invalid(
    `This page's stored content is not well-formed Confluence storage format: ${detail}. ` +
      `Section editing computes offsets into that markup, and offsets taken from markup the ` +
      `parser had to repair cannot be trusted, so no edit is attempted. ${NOT_MODIFIED} ` +
      `Repair the page with update_confluence_page (read it first with format: 'storage').`
  );
}

/**
 * Locate a section by heading text (spec: "A section is addressed by heading").
 *
 * Matching uses `foldHeadingText` -- the SINGLE definition of heading equality, and the same
 * function `HeadingEntry.occurrence` is numbered over. A case-insensitive retry is a FALLBACK
 * only: occurrence indices are numbered over the exact fold, so `Setup` and `setup` are each
 * occurrence 1 and a case-folded match set of more than one cannot be disambiguated by index
 * at all. That case is reported as ambiguous rather than renumbered.
 */
export function resolveSection(result: TokenizeResult, request: SectionRequest): ResolvedSection {
  const heading = typeof request.heading === 'string' ? request.heading : '';
  if (heading.trim() === '') {
    throw invalid(
      `A section edit requires the "heading" of the section to act on. ${NOT_MODIFIED} ` +
        `Read the page with get_confluence_page to see its outline.`
    );
  }

  const outline = collectHeadingOutline(result);
  if (outline.length === 0) {
    throw invalid(
      `This page has no headings, so no section can be addressed. ${NOT_MODIFIED} Use ` +
        `update_confluence_page to write the whole page.`
    );
  }

  const wanted = foldHeadingText(heading);
  let candidates = outline.filter((entry) => foldHeadingText(entry.text) === wanted);
  let matchedCaseInsensitively = false;

  if (candidates.length === 0) {
    const lowered = wanted.toLowerCase();
    candidates = outline.filter((entry) => foldHeadingText(entry.text).toLowerCase() === lowered);
    matchedCaseInsensitively = candidates.length > 0;
  }

  if (candidates.length === 0) {
    throw invalid(
      `No heading matching ${JSON.stringify(heading)} was found on this page. ${NOT_MODIFIED} ` +
        `The headings that do exist are: ${listHeadings(outline)}.`
    );
  }

  const entry = selectCandidate(candidates, request.occurrence, matchedCaseInsensitively, heading);

  if (!entry.addressable) {
    const blocking = blockingAncestorsOf(result, entry.elementIndex)
      .map((element) => `<${element.name}>`)
      .join(' > ');
    const addressable = outline.filter((candidate) => candidate.addressable);
    throw invalid(
      `The heading ${JSON.stringify(entry.text)} is inside ${blocking}, which section editing ` +
        `treats as opaque -- macro bodies and table cells are never spliced into, and a ` +
        `heading nested in ordinary markup is not a section boundary. It was not found among ` +
        `the addressable headings, which are: ${listHeadings(addressable)}. ${NOT_MODIFIED} ` +
        `Use update_confluence_page to change content inside an opaque region.`
    );
  }

  return resolveOffsets(result, entry, outline);
}

function selectCandidate(
  candidates: HeadingEntry[],
  occurrence: number | undefined,
  matchedCaseInsensitively: boolean,
  requested: string
): HeadingEntry {
  if (matchedCaseInsensitively && candidates.length > 1) {
    throw invalid(
      `${JSON.stringify(requested)} matches ${candidates.length} headings only when letter ` +
        `case is ignored, and occurrence indices are numbered over the exact heading text, so ` +
        `they cannot separate these. ${NOT_MODIFIED} Supply the heading exactly as ` +
        `get_confluence_page reports it: ${listHeadings(candidates)}.`
    );
  }

  if (occurrence === undefined) {
    if (candidates.length > 1) {
      throw invalid(
        `${JSON.stringify(requested)} matches ${candidates.length} headings on this page. ` +
          `${NOT_MODIFIED} Supply "occurrence" to choose one: ${listHeadings(candidates)}.`
      );
    }
    return candidates[0];
  }

  const chosen = candidates.find((candidate) => candidate.occurrence === occurrence);
  if (!chosen) {
    throw invalid(
      `No heading ${JSON.stringify(requested)} with occurrence ${occurrence} exists on this ` +
        `page. ${NOT_MODIFIED} The available matches are: ${listHeadings(candidates)}.`
    );
  }
  return chosen;
}

/**
 * The three offsets, plus the same-container invariant assertion (task 6.1d).
 *
 * `sectionEnd` is computed ONLY among headings whose nearest sectioning container is the
 * target's own (D3, nearest-container scoping). A heading in a deeper container -- a macro
 * body, a table cell, or a layout cell nested inside this section -- is invisible here, so an
 * outer section's extent runs past the entire construct rather than splicing into it.
 */
function resolveOffsets(
  result: TokenizeResult,
  entry: HeadingEntry,
  outline: HeadingEntry[]
): ResolvedSection {
  const position = outline.findIndex((candidate) => candidate.elementIndex === entry.elementIndex);
  const element = result.elements[entry.elementIndex];
  const container = nearestContainerOf(result, entry.elementIndex);

  if (!element || element.closeTokenIndex === -1) {
    throw invalid(
      `The heading ${JSON.stringify(entry.text)} has no closing tag in the stored content, so ` +
        `the start of its body cannot be located. ${NOT_MODIFIED}`
    );
  }

  let sectionEnd = container.contentEnd;
  let boundaryIndex = -1;

  for (let i = position + 1; i < outline.length; i += 1) {
    const other = outline[i];
    if (!other.addressable) continue;
    if (other.level > entry.level) continue;
    if (nearestContainerOf(result, other.elementIndex).index !== container.index) continue;
    sectionEnd = result.elements[other.elementIndex].start;
    boundaryIndex = other.elementIndex;
    break;
  }

  const section: ResolvedSection = {
    level: entry.level,
    text: entry.text,
    occurrence: entry.occurrence,
    headingStart: element.start,
    bodyStart: element.end,
    sectionEnd,
    container,
    elementIndex: entry.elementIndex,
  };

  assertSameContainer(result, section, boundaryIndex);
  return section;
}

/**
 * Task 6.1d: reject rather than splice when the boundaries cannot be placed in one container.
 *
 * Every clause here should be unreachable given `isAddressable`, and that is the point -- this
 * is the assertion that turns "the resolver is correct" from a claim into a checked property.
 */
function assertSameContainer(
  result: TokenizeResult,
  section: ResolvedSection,
  boundaryIndex: number
): void {
  const heading = result.elements[section.elementIndex];
  const problems: string[] = [];

  if (heading.parent !== section.container.index) {
    problems.push(
      `the heading is not a direct child of ${section.container.name ?? 'the document root'}`
    );
  }
  if (boundaryIndex !== -1 && result.elements[boundaryIndex].parent !== section.container.index) {
    problems.push('the section end falls in a different container from its start');
  }
  if (section.bodyStart > section.sectionEnd) {
    problems.push('the section body ends before it begins');
  }
  if (
    section.headingStart < section.container.contentStart ||
    section.sectionEnd > section.container.contentEnd
  ) {
    problems.push('the section extends outside its container');
  }

  if (problems.length === 0) return;

  throw invalid(
    `The boundaries of section ${JSON.stringify(section.text)} could not be placed within a ` +
      `single sectioning container: ${problems.join('; ')}. Splicing there could orphan ` +
      `closing tags, so the edit is rejected. ${NOT_MODIFIED}`
  );
}

/**
 * The span each operation acts on (design.md D3).
 *
 * - `replace` acts on `bodyStart..sectionEnd`, so the heading survives without the caller
 *   re-supplying it and is not duplicated.
 * - `append` and `insert-after` are zero-width insertions at `sectionEnd`.
 *
 * NOTE for reviewers: appending to a mid-page section inserts AFTER whatever whitespace
 * precedes the next heading, because `sectionEnd` is that heading's `headingStart` and D3
 * forbids adjusting whitespace on either side of a splice. That is mandated behavior
 * (task 6.12), not an oversight.
 */
export function operationSpan(section: ResolvedSection, operation: SectionOperation): SectionSpan {
  if (operation === 'replace') {
    return { start: section.bodyStart, end: section.sectionEnd };
  }
  return { start: section.sectionEnd, end: section.sectionEnd };
}

/**
 * The splice itself. The whole byte-for-byte guarantee lives in this one expression: the
 * regions outside the span are carried through as slices of the original string and are never
 * looked at.
 */
export function spliceSection(source: string, span: SectionSpan, fragment: string): string {
  return source.slice(0, span.start) + fragment + source.slice(span.end);
}

/** XML text escaping for the heading text an insert operation supplies as plain text. */
export function escapeStorageText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the fragment an insert-after operation splices in: a heading element followed by the
 * supplied body, with NO whitespace between them (task 6.12 -- nothing is inserted that the
 * caller did not supply).
 */
export function buildInsertedSection(heading: string, level: number, body: string): string {
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw invalid(
      `"level" must be a whole number from 1 to 6, received ${JSON.stringify(level)}. ` +
        `${NOT_MODIFIED}`
    );
  }
  if (typeof heading !== 'string' || heading.trim() === '') {
    throw invalid(`An insert operation requires "newHeading" text. ${NOT_MODIFIED}`);
  }
  return `<h${level}>${escapeStorageText(heading)}</h${level}>${body}`;
}

/**
 * Validate the ASSEMBLED document (task 6.8a, design.md D3).
 *
 * A fragment well-formed in isolation is not proof the spliced document is: a trailing `<!`
 * is an unterminated declaration that tokenizes cleanly on its own and then swallows the
 * closing tag that follows it once spliced. This runs on the whole assembled string, before
 * any request to Confluence.
 */
export function assertAssembledWellFormed(assembled: string): TokenizeResult {
  try {
    return assertWellFormed(assembled, 'page content assembled from this section edit');
  } catch (error) {
    if (error instanceof McpError) {
      throw invalid(
        `Splicing this section produced content that is not well-formed: assembly produced ` +
          `invalid content. ${error.message} No request to modify the page was made.`
      );
    }
    throw error;
  }
}

/** Convenience for tests and callers holding only a string. */
export function resolveSectionIn(source: string, request: SectionRequest): ResolvedSection {
  const result = tokenize(source);
  assertCurrentContentUsable(result);
  return resolveSection(result, request);
}

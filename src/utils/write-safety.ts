/**
 * The safety contract every write path shares (spec: page-write-safety; design.md D5, D6, D8,
 * D10, D11, D12).
 *
 * Three separate failures put corrupted content on live pages, and this module closes all of
 * them at the same choke point:
 *
 * 1. An agent reads a page as markdown, edits the markdown, and writes the markdown back into
 *    the storage field. Confluence stores XHTML, so `## Heading` renders as the literal
 *    characters `## Heading`. Measured on 3,942 live pages this is the dominant failure mode
 *    (design.md D8).
 * 2. The same round trip drops every macro the markdown renderer could not represent -- on 11
 *    live pages a working table-of-contents macro was replaced by this server's own
 *    `[Confluence Macro: toc (...)]` placeholder text.
 * 3. The old converter emitted `1. $1` for ordered lists, and that text was written back.
 *
 * None of these is catchable by well-formedness validation: `### Heading` is a perfectly valid
 * XHTML text node. Each therefore gets its own check, and the checks run in a FIXED order
 * (design.md D10) so the caller is told the most specific, most actionable thing first.
 *
 * Everything here is written to be reusable span-scoped by section editing (section 6): the
 * checks take a tokenized document and an optional span, `collectConstructs` already accepts a
 * span, and `PREFLIGHT_CHECK_ORDER` is exported as DATA so a second caller cannot reuse the
 * checks in a different order and still look correct.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { collectConstructs, type ConstructSpan } from './storage-constructs.js';
import {
  decodeEntities,
  tokenize,
  wellFormednessErrors,
  type StorageToken,
  type TokenizeResult,
} from './storage-tokenizer.js';

// ---------------------------------------------------------------------------
// Text projection -- the load-bearing primitive for every content check
// ---------------------------------------------------------------------------

/**
 * Elements that do NOT introduce a line break in the projection.
 *
 * Everything else -- including unknown and `ac:`/`ri:` elements -- is treated as a block and
 * contributes a newline. Newlines only ever CREATE line starts inside text we already decided
 * to scan; joining is the direction that manufactures a `**` out of two adjacent single `*`s,
 * so defaulting to block is the conservative choice.
 *
 * `code` is inline here even though its CONTENT is excluded: `<p>See <code>x</code>## y</p>`
 * must not turn `## y` into a line start. Excluding a region and breaking a line are separate
 * decisions and are kept separate below.
 */
const INLINE_ELEMENTS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'b',
  'big',
  'cite',
  'code',
  'del',
  'em',
  'i',
  'ins',
  'kbd',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
]);

/**
 * Regions whose text is invisible to the markdown and artifact checks.
 *
 * Spec: markdown syntax inside a code or preformatted region is legitimate content, and
 * `$1::vector` in a code block is a Postgres bind parameter, not a conversion artifact. CDATA
 * is excluded by token type rather than by element name, since that is how Confluence wraps
 * code-macro bodies.
 */
const EXCLUDED_CONTENT_ELEMENTS: ReadonlySet<string> = new Set([
  'code',
  'pre',
  'ac:plain-text-body',
]);

/** Element indices whose content is excluded, and everything nested inside them. */
function buildExclusionPredicate(result: TokenizeResult): (elementIndex: number) => boolean {
  const memo = new Map<number, boolean>();

  return function inside(elementIndex: number): boolean {
    if (elementIndex === -1) return false;
    const cached = memo.get(elementIndex);
    if (cached !== undefined) return cached;

    const element = result.elements[elementIndex];
    const excluded = element
      ? EXCLUDED_CONTENT_ELEMENTS.has(element.name) || inside(element.parent)
      : false;
    memo.set(elementIndex, excluded);
    return excluded;
  };
}

/**
 * Render the document's TEXT as the reader sees its line structure.
 *
 * Why this exists rather than running line-anchored regexes over the raw source: the observed
 * corruption is text, and text is routinely wrapped. `<p>## Executive Summary</p>` has no
 * line-initial `##` in the source at all, so a source-level scan misses the single most common
 * shape of the bug. Projecting block boundaries to newlines and dropping tags puts the text
 * back on the lines Confluence will render it on.
 *
 * Offsets are deliberately NOT preserved: no check needs a location in the projection (the
 * corrective message is the payload, per D8), and pretending to carry offsets through a
 * lossy projection would invite section 6 to splice against them.
 */
export function buildTextProjection(result: TokenizeResult, span?: ConstructSpan): string {
  const isExcluded = buildExclusionPredicate(result);
  const parts: string[] = [];

  for (const token of result.tokens) {
    if (span && (token.start < span.start || token.end > span.end)) continue;

    if (token.type === 'element') {
      if (!INLINE_ELEMENTS.has(token.name)) parts.push('\n');
      continue;
    }
    if (token.type !== 'text') continue;
    if (isExcluded(token.parentElement)) continue;
    parts.push(decodeEntities(token.raw));
  }

  return parts.join('');
}

/** Text of one element, entity-decoded, with excluded regions removed. */
function elementText(result: TokenizeResult, elementIndex: number): string {
  const element = result.elements[elementIndex];
  if (!element || element.closeTokenIndex === -1) return '';
  const isExcluded = buildExclusionPredicate(result);

  let text = '';
  for (let i = element.openTokenIndex + 1; i < element.closeTokenIndex; i += 1) {
    const token: StorageToken | undefined = result.tokens[i];
    if (!token || token.type !== 'text') continue;
    if (isExcluded(token.parentElement)) continue;
    text += decodeEntities(token.raw);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * Markdown structural signals, evaluated on the text projection.
 *
 * `heading` requires TWO to six hashes: a single `#` is not a signal (spec, D8) -- it is an
 * ordinary character in prose, an issue reference, and a CSS id selector.
 *
 * `bullet` is deliberately NOT grounds for rejection on its own. Bare `-`/`*` bullets appear
 * on ~360 corpus pages of legitimate human-authored prose; rejecting them would make the
 * server actively obstructive. It counts only alongside a high-confidence signal. This
 * carve-out is evidence-backed -- do not "tighten" it.
 */
const MARKDOWN_SIGNALS: ReadonlyArray<{
  id: 'heading' | 'emphasis' | 'fence' | 'bullet';
  confidence: 'high' | 'ambiguous';
  label: string;
  pattern: RegExp;
}> = [
  {
    id: 'heading',
    confidence: 'high',
    label: 'a markdown heading',
    pattern: /^[ \t]*(#{2,6})(?!#)[ \t]+\S/m,
  },
  {
    id: 'emphasis',
    confidence: 'high',
    label: 'markdown `**` emphasis',
    pattern: /\*\*[^\s*][^\n*]*\*\*/,
  },
  {
    id: 'fence',
    confidence: 'high',
    label: 'a markdown fenced code block',
    pattern: /^[ \t]*```/m,
  },
  {
    id: 'bullet',
    confidence: 'ambiguous',
    label: 'a markdown bullet',
    pattern: /^[ \t]*[-*][ \t]+\S/m,
  },
];

export interface MarkdownSignal {
  id: string;
  confidence: 'high' | 'ambiguous';
  label: string;
  /** The matched line or fragment, trimmed and truncated, for the error message. */
  sample: string;
  /**
   * The whole projection LINE the match sits on, for `validate_confluence_content`.
   *
   * `sample` is the regex match and nothing more -- a heading match is the literal `"## H"`,
   * because the pattern stops at the first non-space character. That is fine in the rejection
   * message, where the label already says what was found, and useless as a location for an
   * agent trying to find the offending line in its own draft.
   */
  line: string;
}

/** Every markdown signal present in the projection, high-confidence and ambiguous alike. */
export function detectMarkdownSignals(projection: string): MarkdownSignal[] {
  const found: MarkdownSignal[] = [];
  for (const signal of MARKDOWN_SIGNALS) {
    const match = signal.pattern.exec(projection);
    if (!match) continue;
    found.push({
      id: signal.id,
      confidence: signal.confidence,
      label: signal.label,
      sample: sample(match[0]),
      line: sample(lineAt(projection, match.index)),
    });
  }
  return found;
}

/**
 * This server's own macro placeholder (design.md D8).
 *
 * Written as a prefix match ON PURPOSE. The label embeds parameter VALUES and does not escape
 * `]`, so `[Confluence Macro: toc (style: square])]` is reachable and the obvious
 * `/\[Confluence Macro:[^\]]*\]/` mis-matches it. The closing bracket carries no information
 * the check needs, so it is never looked for.
 */
const MACRO_PLACEHOLDER = /\[Confluence Macro:\s*\S/;

/**
 * The `$1` conversion artifact (design.md D6).
 *
 * This regex is the corpus-validated scan signature and is reproduced VERBATIM. It already
 * discriminates against the legitimate content the live scan found -- `$1.2M`, `$1K`,
 * `$1,505,674`, `$1::vector`.
 *
 * Known residual false positive, accepted rather than papered over: prose of the form
 * `"...in 2018. $1.2M was..."` matches, because a year-and-period is indistinguishable from a
 * list ordinal once the list markup is gone. Widening the lookahead to `(?![0-9.,])` would fix
 * that and simultaneously stop detecting `1. $1.` at the end of a sentence -- the actual bug.
 * The override for this case is `allowMarkdownContent`'s sibling: rewrite the sentence, or
 * wrap the figure in `<code>`.
 */
const ARTIFACT_BARE_TEXT = /[0-9]+\.\s*\$1(?![0-9])/;

/** The placeholder a list item collapses to when the old converter lost its content. */
const ARTIFACT_LIST_ITEM = '$1';

/** The whole line `index` falls on, unbounded by the match that found it. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end);
}

function sample(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 60)}...` : collapsed;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

export type PreflightCheckName =
  'well-formedness' | 'markdown' | 'macro-placeholder' | 'conversion-artifact' | 'construct-loss';

/**
 * The order checks run in (design.md D10), exported as DATA.
 *
 * Order is a correctness property, not a style choice: markdown submitted as storage contains
 * no macros, so it ALSO trips construct-loss. Running construct-loss first would tell the
 * agent "you removed a macro" when the actionable truth is "this is markdown, not storage."
 *
 * Section 6 reuses these checks span-scoped and must iterate this list rather than calling the
 * checks in an order of its own.
 */
export const PREFLIGHT_CHECK_ORDER: readonly PreflightCheckName[] = [
  'well-formedness',
  'markdown',
  'macro-placeholder',
  'conversion-artifact',
  'construct-loss',
];

/**
 * Where a problem is, when it can be located.
 *
 * `offset` is an offset into the SUBMITTED content and is supplied only by well-formedness,
 * which works on the raw source. The other checks run over the text projection, which
 * deliberately does not preserve offsets (see `buildTextProjection`), so they quote a
 * `snippet` instead of inventing a position.
 */
export interface PreflightLocation {
  offset?: number;
  snippet?: string;
}

export interface PreflightFailure {
  check: PreflightCheckName;
  /**
   * The prose an agent is shown when a write is rejected. Load-bearing and asserted against;
   * `remedy` and `location` are added ALONGSIDE it, never carved out of it.
   */
  message: string;
  location?: PreflightLocation;
  /** The single corrective action, as one imperative sentence a machine can act on. */
  remedy: string;
}

export interface PreflightContext {
  /** The submitted storage content. */
  content: string;
  /** `content`, tokenized once and shared by every check. */
  tokenized: TokenizeResult;
  /** Text projection of `content`. */
  projection: string;
  /** Current page storage, when construct-loss applies. `undefined` on create. */
  currentContent?: string;
  currentTokenized?: TokenizeResult;
  /** Restrict the construct-loss comparison to this span of the CURRENT content (D6). */
  currentSpan?: ConstructSpan;
  allowMarkdownContent: boolean;
  confirmConstructRemoval: boolean;
  /** How the content is named in error messages -- `content`, `section content`. */
  label: string;
}

const RETRIEVE_STORAGE = "Retrieve the page with format: 'storage' and author against that markup.";

const NOT_MODIFIED = 'The page was not modified.';

function checkWellFormedness(ctx: PreflightContext): PreflightFailure | null {
  const errors = wellFormednessErrors(ctx.tokenized);
  if (errors.length === 0) return null;

  const detail = errors
    .slice(0, 3)
    .map((notice) => `${notice.message} (offset ${notice.start})`)
    .join('; ');
  const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : '';

  return {
    check: 'well-formedness',
    message:
      `Submitted ${ctx.label} is not well-formed Confluence storage format: ${detail}${more}. ` +
      `${NOT_MODIFIED} Correct the markup -- every element must be closed and properly ` +
      `nested -- and retry.`,
    location: {
      offset: errors[0]!.start,
      snippet: sample(ctx.content.slice(errors[0]!.start, errors[0]!.start + 60)),
    },
    remedy:
      `Close every element and nest them properly at offset ${errors[0]!.start} ` +
      `(${errors[0]!.message}), then validate again.`,
  };
}

function checkMarkdown(ctx: PreflightContext): PreflightFailure | null {
  if (ctx.allowMarkdownContent) return null;

  const signals = detectMarkdownSignals(ctx.projection);
  const high = signals.filter((signal) => signal.confidence === 'high');
  if (high.length === 0) return null;

  const described = signals
    .map((signal) => `${signal.label} (${JSON.stringify(signal.sample)})`)
    .join(', ');

  return {
    check: 'markdown',
    message:
      `Submitted ${ctx.label} appears to be markdown, not Confluence storage format: ` +
      `${described}. Confluence storage format is XHTML -- markdown syntax stored in it ` +
      `renders as literal characters. ${RETRIEVE_STORAGE} ${NOT_MODIFIED} If this prose ` +
      `genuinely contains markdown-like syntax, set allowMarkdownContent: true.`,
    location: { snippet: high[0]!.line },
    remedy:
      `Rewrite the markdown as XHTML -- "## Heading" becomes <h2>Heading</h2>, "**bold**" ` +
      `becomes <strong>bold</strong>, a "\`\`\`" fence becomes <ac:structured-macro ` +
      `ac:name="code">. ${RETRIEVE_STORAGE} Only if the prose genuinely documents markdown ` +
      `syntax, re-run with allowMarkdownContent: true.`,
  };
}

function checkMacroPlaceholder(ctx: PreflightContext): PreflightFailure | null {
  const match = MACRO_PLACEHOLDER.exec(ctx.projection);
  if (!match) return null;

  const line = ctx.projection.slice(match.index, match.index + 120).split('\n')[0];

  return {
    check: 'macro-placeholder',
    message:
      `Submitted ${ctx.label} contains this server's rendered macro placeholder ` +
      `(${JSON.stringify(sample(line))}) rather than macro markup. That text is markdown ` +
      `output; writing it back replaces a working macro with literal text. ` +
      `${RETRIEVE_STORAGE} ${NOT_MODIFIED} If you are documenting the placeholder format, ` +
      `put it inside a <code> or <pre> block.`,
    location: { snippet: sample(line ?? '') },
    remedy:
      `Replace the placeholder text with the macro's real <ac:structured-macro> markup, ` +
      `copied from the page read with format: 'storage'. If you are documenting the ` +
      `placeholder itself, wrap it in <code> or <pre>.`,
  };
}

function checkConversionArtifact(ctx: PreflightContext): PreflightFailure | null {
  const bare = ARTIFACT_BARE_TEXT.exec(ctx.projection);
  if (bare) {
    return artifactFailure(ctx, `the text ${JSON.stringify(sample(bare[0]))}`, sample(bare[0]));
  }

  // The `<li>` form. Its text is read with the SAME code-region exclusion as the bare-text
  // form, so `<li><code>$1</code></li>` -- a Postgres bind documented in a bulleted list --
  // is accepted rather than mistaken for a lost list item.
  for (const element of ctx.tokenized.elements) {
    if (element.name !== 'li') continue;
    if (elementText(ctx.tokenized, element.index).trim() !== ARTIFACT_LIST_ITEM) continue;
    return artifactFailure(ctx, 'a list item whose entire text is "$1"', '<li>$1</li>');
  }

  return null;
}

function artifactFailure(ctx: PreflightContext, detail: string, snippet: string): PreflightFailure {
  return {
    check: 'conversion-artifact',
    message:
      `Submitted ${ctx.label} contains a markdown-conversion artifact -- ${detail}. This is ` +
      `the signature of content that was read through a lossy converter and is now being ` +
      `written back; the original list text is already gone from it. ${RETRIEVE_STORAGE} ` +
      `${NOT_MODIFIED}`,
    location: { snippet },
    remedy:
      `Do not repair the "$1" in place -- the text it replaced is gone. Re-read the page with ` +
      `format: 'storage', take the real list markup from it, and rebuild the edit on that. If ` +
      `the "$1" is genuine content (a bind parameter, a shell variable), wrap it in <code>.`,
  };
}

/**
 * Construct-loss detection (design.md D6).
 *
 * Scoped to MACROS and LAYOUTS, exactly as the spec words it, and deliberately not to every
 * namespaced element: `ac:parameter` is inventoried too, so comparing all namespaced elements
 * would reject a legitimate edit that merely changes a macro's parameters. Section 6 inherits
 * this scope when it runs the check over a span.
 */
function checkConstructLoss(ctx: PreflightContext): PreflightFailure | null {
  if (ctx.currentTokenized === undefined) return null;
  if (ctx.confirmConstructRemoval) return null;

  const current = collectConstructs(ctx.currentTokenized, ctx.currentSpan);
  const submitted = collectConstructs(ctx.tokenized);

  const lost: string[] = [];
  for (const [signature, count] of Object.entries(current.counts)) {
    if (!signature.startsWith('macro:') && !signature.startsWith('layout:')) continue;
    const retained = submitted.counts[signature] ?? 0;
    if (retained >= count) continue;

    const [kind, ...rest] = signature.split(':');
    const name = rest.join(':');
    lost.push(
      kind === 'macro'
        ? `macro "${name}" (page has ${count}, submission has ${retained})`
        : `layout element "${name}" (page has ${count}, submission has ${retained})`
    );
  }

  if (lost.length === 0) return null;

  return {
    check: 'construct-loss',
    message:
      `This write would remove ${lost.length} construct(s) present on the current page: ` +
      `${lost.join('; ')}. Markdown cannot represent macros or layouts, so this is what a ` +
      `write built from a markdown read looks like. ${RETRIEVE_STORAGE} ${NOT_MODIFIED} If ` +
      `the removal is intended, set confirmConstructRemoval: true.`,
    location: { snippet: lost[0]! },
    remedy:
      `Re-read the page with format: 'storage', copy the missing construct markup into the ` +
      `content at the position it belongs, and validate again. Only if the removal is ` +
      `deliberate, re-run with confirmConstructRemoval: true.`,
  };
}

const CHECKS: Record<PreflightCheckName, (ctx: PreflightContext) => PreflightFailure | null> = {
  'well-formedness': checkWellFormedness,
  markdown: checkMarkdown,
  'macro-placeholder': checkMacroPlaceholder,
  'conversion-artifact': checkConversionArtifact,
  'construct-loss': checkConstructLoss,
};

/** Run one named check. Exported so section 6 can reuse a check without the whole pipeline. */
export function runPreflightCheck(
  name: PreflightCheckName,
  ctx: PreflightContext
): PreflightFailure | null {
  return CHECKS[name](ctx);
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export interface PreflightInput {
  /** The storage content being submitted -- a whole page body, or a section fragment. */
  content: string;
  /** Already-tokenized `content`, when the caller has it (section 6 does). */
  tokenized?: TokenizeResult;
  /**
   * The page's current storage, for construct-loss.
   *
   * Omit entirely to SKIP the check -- that is what `create_confluence_page` does, since there
   * is no prior version to compare against, and what append/insert section operations do,
   * since they remove nothing (D6).
   *
   * A function is resolved lazily, and only if the pipeline reaches the construct-loss check.
   * That is what lets a whole-page update reject malformed or markdown content without making
   * a single request to Confluence.
   */
  currentContent?: string | (() => string | Promise<string>);
  /** Restrict the construct-loss comparison to this span of the current content (D6). */
  currentSpan?: ConstructSpan;
  allowMarkdownContent?: boolean;
  confirmConstructRemoval?: boolean;
  /** How the content is named in error messages. Defaults to `content`. */
  label?: string;
}

/**
 * The one pipeline both callers run (task: content-validator).
 *
 * `stopAtFirstFailure` is the ONLY difference between the write path and the validator. It is
 * a parameter rather than a second implementation on purpose: a validator that could report
 * "clean" for content the write path then rejects is worse than no validator at all, so there
 * is deliberately no second place where the check list, the check order, or the contexts the
 * checks see could drift.
 *
 * Note what the flag does NOT change: checks still run in `PREFLIGHT_CHECK_ORDER`, and the
 * returned array is in that order, so `failures[0]` is always the same failure the
 * short-circuiting write path would have reported.
 */
async function runPreflightPipeline(
  input: PreflightInput,
  stopAtFirstFailure: boolean
): Promise<PreflightFailure[]> {
  const tokenized = input.tokenized ?? tokenize(input.content);
  const ctx: PreflightContext = {
    content: input.content,
    tokenized,
    projection: buildTextProjection(tokenized),
    currentSpan: input.currentSpan,
    allowMarkdownContent: input.allowMarkdownContent === true,
    confirmConstructRemoval: input.confirmConstructRemoval === true,
    label: input.label ?? 'content',
  };

  const failures: PreflightFailure[] = [];

  for (const name of PREFLIGHT_CHECK_ORDER) {
    if (name === 'construct-loss' && input.currentContent !== undefined) {
      // Resolved HERE, not earlier: the checks before this one need no network at all. With
      // `stopAtFirstFailure`, an earlier failure means this is never reached and no request is
      // made -- the property the whole-page write path depends on.
      const currentContent =
        typeof input.currentContent === 'function'
          ? await input.currentContent()
          : input.currentContent;
      ctx.currentContent = currentContent;
      ctx.currentTokenized = tokenize(currentContent);
    }

    const failure = runPreflightCheck(name, ctx);
    if (failure) {
      failures.push(failure);
      if (stopAtFirstFailure) return failures;
    }
  }

  return failures;
}

/**
 * Run every preflight check in `PREFLIGHT_CHECK_ORDER` and return the FIRST failure.
 *
 * Async only because of the lazy current-content resolver; with a string (or nothing) it never
 * awaits anything real.
 */
export async function preflight(input: PreflightInput): Promise<PreflightFailure | null> {
  const failures = await runPreflightPipeline(input, true);
  return failures[0] ?? null;
}

/**
 * Every failure, in `PREFLIGHT_CHECK_ORDER`, rather than only the first.
 *
 * This is what `validate_confluence_content` reports. The write path must NOT use it: it is
 * strictly more work (the construct-loss resolver runs even when an earlier check already
 * failed, which for a write would mean a Confluence request the rejection did not need), and
 * a write has nothing to do with the second failure anyway. The agreement property tests rely
 * on is `preflightAll(x)[0] === preflight(x)`.
 */
export async function preflightAll(input: PreflightInput): Promise<PreflightFailure[]> {
  return runPreflightPipeline(input, false);
}

/** As `preflight`, but throws the failure as an `McpError` the tool layer returns verbatim. */
export async function assertWriteIsSafe(input: PreflightInput): Promise<void> {
  const failure = await preflight(input);
  if (failure) {
    throw new McpError(ErrorCode.InvalidParams, failure.message);
  }
}

/** Well-formedness on its own -- what section 6 runs over the ASSEMBLED document (6.8a). */
export function assertWellFormed(content: string, label = 'content'): TokenizeResult {
  const tokenized = tokenize(content);
  const failure = checkWellFormedness({
    content,
    tokenized,
    projection: '',
    allowMarkdownContent: false,
    confirmConstructRemoval: false,
    label,
  });
  if (failure) throw new McpError(ErrorCode.InvalidParams, failure.message);
  return tokenized;
}

// ---------------------------------------------------------------------------
// Versions and conflicts (design.md D5, D12)
// ---------------------------------------------------------------------------

export interface VersionConflict {
  /** The version the write was built on. `null` when it could not be established. */
  expectedVersion: number | null;
  /** The version the page is actually at. `null` when re-reading it also failed. */
  currentVersion: number | null;
}

/**
 * The ONE constructor for a version conflict, whoever detected it (design.md D12).
 *
 * Both paths -- the local `expectedVersion` comparison and Confluence rejecting the submitted
 * version in the race window after resolution -- call this, so a caller has one error shape to
 * handle and a test written against the local check cannot silently miss the remote one.
 */
export function versionConflictError(conflict: VersionConflict): McpError {
  const expected = conflict.expectedVersion === null ? 'unknown' : String(conflict.expectedVersion);
  const current =
    conflict.currentVersion === null
      ? 'a different version (Confluence rejected the write and the current version could not be re-read)'
      : `version ${conflict.currentVersion}`;

  return new McpError(
    ErrorCode.InvalidParams,
    `Version conflict: this write expected version ${expected} but the page is at ${current}. ` +
      `Another author changed the page. ${NOT_MODIFIED} Re-read it with get_confluence_page ` +
      `and reapply the change to the current content.`
  );
}

/** Throw the uniform conflict error when a supplied `expectedVersion` is stale (task 5.3). */
export function assertExpectedVersion(
  expectedVersion: number | undefined,
  currentVersion: number
): void {
  if (expectedVersion === undefined) return;
  if (expectedVersion === currentVersion) return;
  throw versionConflictError({ expectedVersion, currentVersion });
}

/**
 * The version to SUBMIT for a page currently at `currentVersion` (design.md D5).
 *
 * Trivial by design. It exists as a named function because the bug it replaces was arithmetic
 * the CALLER was told to do -- the update tool's description used to end "TIP: Increment the
 * version number by 1 when updating," and an agent that also passed the pre-increment version
 * got a 409 it could not diagnose.
 */
export function resolveWriteVersion(currentVersion: number): number {
  return currentVersion + 1;
}

/**
 * Whether a rejected write was Confluence reporting a version conflict (design.md D12).
 *
 * Deliberately tolerant about the status code. Confluence v2 has been observed to answer a
 * stale version with both 409 and 400, and this cannot be pinned down without a live write --
 * which is task 7.5, not this one. Over-classifying costs a slightly wrong (but still
 * accurate: the write failed, the page is unchanged) message; under-classifying returns the
 * unclassified API failure the spec forbids.
 */
export function isVersionConflictResponse(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: number }).status;
  if (status === 409) return true;
  if (status !== undefined && status !== 400) return false;
  return /version/i.test(error.message) && !/permission|not found/i.test(error.message);
}

/**
 * Confluence storage-format tokenizer.
 *
 * Storage format is XHTML-like: well-formed nesting, explicit close tags, XHTML self-closing
 * syntax (`<p />`, `<ri:page ... />`), and custom namespaced elements (`ac:`, `ri:`) this
 * server deliberately does not model. See design.md D1/D2/D3.
 *
 * Contract:
 * - every token carries exact source offsets, and `raw === source.slice(start, end)`;
 * - the token stream tiles the source with no gaps and no overlaps;
 * - unknown and namespaced elements pass through uninterpreted;
 * - malformed markup NEVER throws -- it is recorded as a notice and tokenizing continues.
 *
 * Why this is hand-rolled rather than `parse5` (task 2.1/2.2): parse5 is an HTML5 parser, and
 * HTML5 tree construction ignores the self-closing slash on non-void, non-foreign elements.
 * Confluence emits `<p />`, `<ri:page />`, `<ri:url />` and `<ac:emoticon />` routinely, so
 * parse5 leaves those elements open and reparents their following siblings as children. On
 * the captured fixtures that corrupts 37% of sectioning-container ancestries and drops their
 * end-tag offsets entirely -- and the ancestry is exactly what D3's nearest-container rule
 * rests on. parse5's offsets and namespace handling are fine; its tree shape is not.
 *
 * Nesting policy (pinned by tests, relied on by section 6):
 * - XHTML nesting is taken literally. There are NO HTML5 implied end tags: `<p>a<h2>` nests
 *   the heading inside the paragraph rather than auto-closing it.
 * - Self-closing syntax (`/>`) is honoured for EVERY element, not just HTML void elements.
 * - A close tag that does not match the innermost open element is resolved by searching the
 *   open stack for the same name. If found, the elements above it are implicitly closed at
 *   the close tag's start offset. If not found, the close tag is a stray: it is emitted as a
 *   token, a notice is recorded, and the open stack is left untouched.
 * - Elements still open at end of input are implicitly closed at end of input.
 */

/** HTML void elements: never pushed onto the open stack even without a closing slash. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * Sectioning containers (design.md D3). A heading inside one of these is addressable, and a
 * section's extent is computed among the headings that share it as their nearest container.
 */
export const SECTIONING_CONTAINERS: ReadonlySet<string> = new Set([
  'ac:layout',
  'ac:layout-section',
  'ac:layout-cell',
]);

/**
 * Opaque regions (design.md D3). Table cells, plus every `ac:`/`ri:` element that is not a
 * sectioning container -- macro wrappers and macro interiors alike (`ac:structured-macro`,
 * `ac:rich-text-body`, `ac:plain-text-body`, `ac:parameter`, `ac:task-body`, `ac:link-body`,
 * `ac:placeholder`, and anything Confluence adds later). Stated as a prefix rule rather than
 * an allowlist so a heading in an unforeseen macro body cannot slip through as addressable.
 */
const OPAQUE_ELEMENTS: ReadonlySet<string> = new Set(['td', 'th']);

export type ContainerKind = 'sectioning' | 'opaque' | 'transparent';

/** Classify an element name as a sectioning container, an opaque region, or neither. */
export function containerKind(name: string): ContainerKind {
  if (SECTIONING_CONTAINERS.has(name)) return 'sectioning';
  if (OPAQUE_ELEMENTS.has(name)) return 'opaque';
  if (name.startsWith('ac:') || name.startsWith('ri:')) return 'opaque';
  return 'transparent';
}

export interface StorageAttribute {
  /** Lowercased, namespace prefix retained (`ac:name`). */
  name: string;
  /** Exactly as written in the source. */
  rawName: string;
  /** Entity-decoded value. Empty string for a valueless attribute. */
  value: string;
  /** Value exactly as written, without quotes. `null` for a valueless attribute. */
  rawValue: string | null;
  quote: '"' | "'" | null;
  start: number;
  end: number;
}

interface TokenBase {
  start: number;
  end: number;
  /** Always identical to `source.slice(start, end)`. */
  raw: string;
  /** Index of the innermost enclosing element, or -1 at document root. */
  parentElement: number;
}

export interface TextToken extends TokenBase {
  type: 'text';
}

export interface CommentToken extends TokenBase {
  type: 'comment';
}

export interface CdataToken extends TokenBase {
  type: 'cdata';
}

/** `<!DOCTYPE ...>`, `<?xml ...?>`, and other bogus-comment-ish constructs. */
export interface DeclarationToken extends TokenBase {
  type: 'declaration';
}

export interface ElementToken extends TokenBase {
  type: 'element';
  /** Lowercased, namespace prefix retained (`ac:layout-cell`). */
  name: string;
  /** Exactly as written in the source. */
  rawName: string;
  /** `'ac'`, `'ri'`, or `null`. */
  prefix: string | null;
  kind: 'open' | 'close' | 'self-closing';
  attributes: StorageAttribute[];
  /** Index into `TokenizeResult.elements`; -1 for a stray close tag. */
  elementIndex: number;
}

export type StorageToken = TextToken | CommentToken | CdataToken | DeclarationToken | ElementToken;

export interface StorageElement {
  /** Index into `TokenizeResult.elements`. */
  index: number;
  name: string;
  rawName: string;
  prefix: string | null;
  attributes: StorageAttribute[];
  /** Token index of the opening (or self-closing) tag. */
  openTokenIndex: number;
  /** Token index of the matching close tag; -1 when self-closing, void, or never closed. */
  closeTokenIndex: number;
  /** Offset of `<` on the opening tag. */
  start: number;
  /** Offset just past `>` of the closing tag (or of the opening tag when there is none). */
  end: number;
  /** Offset just past `>` of the opening tag -- the start of this element's content. */
  contentStart: number;
  /** Offset of `<` on the closing tag -- the end of this element's content. */
  contentEnd: number;
  /** Index of the enclosing element, or -1 at document root. */
  parent: number;
  /** 0 at document root. */
  depth: number;
  selfClosing: boolean;
  /** True when the source never closed this element and the tokenizer closed it for us. */
  implicitlyClosed: boolean;
}

export type NoticeCode =
  | 'unmatched-close-tag'
  | 'implicitly-closed-element'
  | 'unclosed-element-at-eof'
  | 'unterminated-tag'
  | 'unterminated-comment'
  | 'unterminated-cdata'
  | 'stray-less-than';

export interface TokenizerNotice {
  code: NoticeCode;
  message: string;
  start: number;
  end: number;
}

export interface TokenizeResult {
  source: string;
  tokens: StorageToken[];
  elements: StorageElement[];
  /** Malformed-markup observations. Never thrown; presence here is not a failure. */
  notices: TokenizerNotice[];
}

/** Where a node sits relative to the nearest sectioning container or opaque region. */
export interface ContainerRef {
  /** Index into `TokenizeResult.elements`; -1 means the document root. */
  index: number;
  kind: 'root' | 'sectioning' | 'opaque';
  /** `null` at the document root. */
  name: string | null;
  /** Start of the container's content (0 at the document root). */
  contentStart: number;
  /** End of the container's content (`source.length` at the document root). */
  contentEnd: number;
}

/**
 * Named entities decoded in attribute values and, via `decodeEntities`, in text nodes.
 *
 * Beyond the XML five and `nbsp`, this covers the typographic entities Confluence's editor
 * emits in ordinary prose (curly quotes, dashes, ellipsis, arrows). Leaving those undecoded
 * put raw `&rsquo;` into the markdown an agent reads. Numeric entities are handled
 * generically below, so only named ones need listing.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  sbquo: '\u201a',
  bdquo: '\u201e',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  bull: '\u2022',
  middot: '\u00b7',
  larr: '\u2190',
  uarr: '\u2191',
  rarr: '\u2192',
  darr: '\u2193',
  harr: '\u2194',
  laquo: '\u00ab',
  raquo: '\u00bb',
  times: '\u00d7',
  divide: '\u00f7',
  plusmn: '\u00b1',
  deg: '\u00b0',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  sect: '\u00a7',
  para: '\u00b6',
  dagger: '\u2020',
  prime: '\u2032',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
};

/**
 * Decode the entity subset that appears in Confluence attribute values.
 *
 * Exported because the markdown renderer needs the same decoding for TEXT nodes, and two
 * copies of an entity table is exactly the kind of drift that ends up in page content.
 */
export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (body.startsWith('#')) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named ?? match;
    }
  );
}

const TAG_NAME_START = /[A-Za-z]/;
const TAG_NAME_CHAR = /[A-Za-z0-9:._-]/;
const WHITESPACE = /\s/;

function readTagName(source: string, from: number): { name: string; next: number } | null {
  if (from >= source.length || !TAG_NAME_START.test(source[from])) return null;
  let i = from + 1;
  while (i < source.length && TAG_NAME_CHAR.test(source[i])) i += 1;
  return { name: source.slice(from, i), next: i };
}

/**
 * Parse attributes from `from` up to the tag's `>`.
 *
 * Returns the attributes, whether the tag used self-closing syntax, and the offset just past
 * `>`. An unterminated tag consumes to end of input rather than failing.
 */
function readTag(
  source: string,
  from: number
): { attributes: StorageAttribute[]; selfClosing: boolean; end: number; terminated: boolean } {
  const attributes: StorageAttribute[] = [];
  let i = from;
  let selfClosing = false;

  while (i < source.length) {
    while (i < source.length && WHITESPACE.test(source[i])) i += 1;
    if (i >= source.length) break;

    const ch = source[i];
    if (ch === '>') return { attributes, selfClosing, end: i + 1, terminated: true };
    if (ch === '/') {
      selfClosing = true;
      i += 1;
      continue;
    }

    // Attribute name: anything up to whitespace, '=', '/', '>' or a quote.
    const nameStart = i;
    while (i < source.length && !/[\s"'>/=]/.test(source[i])) i += 1;
    if (i === nameStart) {
      // A quote or '=' with no name in front of it. Skip it so we cannot spin.
      i += 1;
      continue;
    }
    const rawName = source.slice(nameStart, i);

    let j = i;
    while (j < source.length && WHITESPACE.test(source[j])) j += 1;
    if (source[j] !== '=') {
      attributes.push({
        name: rawName.toLowerCase(),
        rawName,
        value: '',
        rawValue: null,
        quote: null,
        start: nameStart,
        end: i,
      });
      selfClosing = false;
      continue;
    }

    j += 1;
    while (j < source.length && WHITESPACE.test(source[j])) j += 1;
    const quoteChar = source[j];
    let rawValue: string;
    let quote: '"' | "'" | null = null;
    if (quoteChar === '"' || quoteChar === "'") {
      quote = quoteChar;
      const close = source.indexOf(quoteChar, j + 1);
      const stop = close === -1 ? source.length : close;
      rawValue = source.slice(j + 1, stop);
      j = close === -1 ? source.length : close + 1;
    } else {
      const start = j;
      while (j < source.length && !/[\s>]/.test(source[j])) j += 1;
      rawValue = source.slice(start, j);
    }

    attributes.push({
      name: rawName.toLowerCase(),
      rawName,
      value: decodeEntities(rawValue),
      rawValue,
      quote,
      start: nameStart,
      end: j,
    });
    i = j;
    selfClosing = false;
  }

  return { attributes, selfClosing, end: source.length, terminated: false };
}

function prefixOf(name: string): string | null {
  const colon = name.indexOf(':');
  return colon === -1 ? null : name.slice(0, colon);
}

/**
 * Tokenize Confluence storage format.
 *
 * Never throws on markup, however malformed. Throws `TypeError` only when `source` is not a
 * string, because that is a caller error rather than a document the tokenizer must survive.
 */
export function tokenize(source: string): TokenizeResult {
  if (typeof source !== 'string') {
    throw new TypeError(`storage tokenizer requires a string, received ${typeof source}`);
  }

  const tokens: StorageToken[] = [];
  const elements: StorageElement[] = [];
  const notices: TokenizerNotice[] = [];
  /** Indices into `elements` for elements that are currently open. */
  const open: number[] = [];

  const currentParent = (): number => (open.length === 0 ? -1 : open[open.length - 1]);

  const push = (token: StorageToken): void => {
    tokens.push(token);
  };

  const emitText = (start: number, end: number): void => {
    if (end <= start) return;
    push({
      type: 'text',
      start,
      end,
      raw: source.slice(start, end),
      parentElement: currentParent(),
    });
  };

  /** Close `elements[elementIndex]` at `at`, marking it implicit. */
  const closeImplicitly = (elementIndex: number, at: number, code: NoticeCode): void => {
    const element = elements[elementIndex];
    element.contentEnd = at;
    element.end = at;
    element.implicitlyClosed = true;
    notices.push({
      code,
      message: `<${element.rawName}> was never closed; treated as ending at offset ${at}`,
      start: element.start,
      end: at,
    });
  };

  let cursor = 0;
  let textStart = 0;

  while (cursor < source.length) {
    const lt = source.indexOf('<', cursor);
    if (lt === -1) break;

    // --- literal regions: comment and CDATA -------------------------------------------
    const literal = (
      openMarker: string,
      closeMarker: string,
      type: 'comment' | 'cdata',
      unterminated: NoticeCode
    ): boolean => {
      if (!source.startsWith(openMarker, lt)) return false;
      const found = source.indexOf(closeMarker, lt + openMarker.length);
      const stop = found === -1 ? source.length : found + closeMarker.length;
      if (found === -1) {
        notices.push({
          code: unterminated,
          message: `unterminated ${type} starting at offset ${lt}`,
          start: lt,
          end: stop,
        });
      }
      emitText(textStart, lt);
      push({
        type,
        start: lt,
        end: stop,
        raw: source.slice(lt, stop),
        parentElement: currentParent(),
      });
      cursor = textStart = stop;
      return true;
    };

    if (literal('<!--', '-->', 'comment', 'unterminated-comment')) continue;
    if (literal('<![CDATA[', ']]>', 'cdata', 'unterminated-cdata')) continue;

    // --- declarations and processing instructions -------------------------------------
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const gt = source.indexOf('>', lt);
      const stop = gt === -1 ? source.length : gt + 1;
      emitText(textStart, lt);
      push({
        type: 'declaration',
        start: lt,
        end: stop,
        raw: source.slice(lt, stop),
        parentElement: currentParent(),
      });
      cursor = textStart = stop;
      continue;
    }

    // --- close tag ---------------------------------------------------------------------
    if (source.startsWith('</', lt)) {
      const parsed = readTagName(source, lt + 2);
      if (!parsed) {
        notices.push({
          code: 'stray-less-than',
          message: `'<' at offset ${lt} does not begin a tag; treated as text`,
          start: lt,
          end: lt + 1,
        });
        cursor = lt + 1;
        continue;
      }
      const gt = source.indexOf('>', parsed.next);
      const stop = gt === -1 ? source.length : gt + 1;
      if (gt === -1) {
        notices.push({
          code: 'unterminated-tag',
          message: `unterminated close tag starting at offset ${lt}`,
          start: lt,
          end: stop,
        });
      }
      const name = parsed.name.toLowerCase();

      let matchDepth = -1;
      for (let k = open.length - 1; k >= 0; k -= 1) {
        if (elements[open[k]].name === name) {
          matchDepth = k;
          break;
        }
      }

      emitText(textStart, lt);

      if (matchDepth === -1) {
        notices.push({
          code: 'unmatched-close-tag',
          message: `</${parsed.name}> at offset ${lt} closes nothing that is open`,
          start: lt,
          end: stop,
        });
        push({
          type: 'element',
          start: lt,
          end: stop,
          raw: source.slice(lt, stop),
          parentElement: currentParent(),
          name,
          rawName: parsed.name,
          prefix: prefixOf(name),
          kind: 'close',
          attributes: [],
          elementIndex: -1,
        });
        cursor = textStart = stop;
        continue;
      }

      // Everything above the match was left open by the source; close it here.
      for (let k = open.length - 1; k > matchDepth; k -= 1) {
        closeImplicitly(open[k], lt, 'implicitly-closed-element');
      }
      const elementIndex = open[matchDepth];
      open.length = matchDepth;

      const element = elements[elementIndex];
      element.contentEnd = lt;
      element.end = stop;
      element.closeTokenIndex = tokens.length;
      push({
        type: 'element',
        start: lt,
        end: stop,
        raw: source.slice(lt, stop),
        parentElement: element.parent,
        name,
        rawName: parsed.name,
        prefix: prefixOf(name),
        kind: 'close',
        attributes: [],
        elementIndex,
      });
      cursor = textStart = stop;
      continue;
    }

    // --- open / self-closing tag -------------------------------------------------------
    const parsed = readTagName(source, lt + 1);
    if (!parsed) {
      // A bare '<' in prose (`3 < 4`). Leave it inside the surrounding text run.
      notices.push({
        code: 'stray-less-than',
        message: `'<' at offset ${lt} does not begin a tag; treated as text`,
        start: lt,
        end: lt + 1,
      });
      cursor = lt + 1;
      continue;
    }

    const tag = readTag(source, parsed.next);
    if (!tag.terminated) {
      notices.push({
        code: 'unterminated-tag',
        message: `unterminated tag starting at offset ${lt}`,
        start: lt,
        end: tag.end,
      });
    }
    const name = parsed.name.toLowerCase();
    // XHTML self-closing syntax is honoured for EVERY element -- this is the parse5 divergence.
    const selfClosing = tag.selfClosing || VOID_ELEMENTS.has(name);

    emitText(textStart, lt);

    const parent = currentParent();
    const elementIndex = elements.length;
    elements.push({
      index: elementIndex,
      name,
      rawName: parsed.name,
      prefix: prefixOf(name),
      attributes: tag.attributes,
      openTokenIndex: tokens.length,
      closeTokenIndex: -1,
      start: lt,
      end: tag.end,
      contentStart: tag.end,
      contentEnd: tag.end,
      parent,
      depth: open.length,
      selfClosing,
      implicitlyClosed: false,
    });

    push({
      type: 'element',
      start: lt,
      end: tag.end,
      raw: source.slice(lt, tag.end),
      parentElement: parent,
      name,
      rawName: parsed.name,
      prefix: prefixOf(name),
      kind: selfClosing ? 'self-closing' : 'open',
      attributes: tag.attributes,
      elementIndex,
    });

    if (!selfClosing) open.push(elementIndex);
    cursor = textStart = tag.end;
  }

  emitText(textStart, source.length);

  for (let k = open.length - 1; k >= 0; k -= 1) {
    closeImplicitly(open[k], source.length, 'unclosed-element-at-eof');
  }

  return { source, tokens, elements, notices };
}

// ---------------------------------------------------------------------------
// Ancestry queries -- what section 6 builds section resolution on.
// ---------------------------------------------------------------------------

/** Ancestors of an element, outermost first. Does not include the element itself. */
export function ancestorsOf(result: TokenizeResult, elementIndex: number): StorageElement[] {
  const chain: StorageElement[] = [];
  let current = result.elements[elementIndex]?.parent ?? -1;
  while (current !== -1) {
    const element = result.elements[current];
    chain.push(element);
    current = element.parent;
  }
  return chain.reverse();
}

/** Ancestors of a token, outermost first. */
export function ancestorsOfToken(result: TokenizeResult, tokenIndex: number): StorageElement[] {
  const token = result.tokens[tokenIndex];
  if (!token || token.parentElement === -1) return [];
  return [...ancestorsOf(result, token.parentElement), result.elements[token.parentElement]];
}

const ROOT_CONTAINER = (source: string): ContainerRef => ({
  index: -1,
  kind: 'root',
  name: null,
  contentStart: 0,
  contentEnd: source.length,
});

function containerFromChain(result: TokenizeResult, chain: StorageElement[]): ContainerRef {
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const element = chain[i];
    const kind = containerKind(element.name);
    if (kind === 'transparent') continue;
    return {
      index: element.index,
      kind,
      name: element.name,
      contentStart: element.contentStart,
      contentEnd: element.contentEnd,
    };
  }
  return ROOT_CONTAINER(result.source);
}

/**
 * The nearest sectioning container or opaque region enclosing an element (design.md D3).
 * Transparent elements (`p`, `div`, `ul`, `li`, `table`, ...) are skipped.
 */
export function nearestContainerOf(result: TokenizeResult, elementIndex: number): ContainerRef {
  return containerFromChain(result, ancestorsOf(result, elementIndex));
}

/** As `nearestContainerOf`, addressed by token index instead. */
export function nearestContainerOfToken(result: TokenizeResult, tokenIndex: number): ContainerRef {
  return containerFromChain(result, ancestorsOfToken(result, tokenIndex));
}

/**
 * Ancestors that prevent an element from being addressable: every ancestor that is not a
 * sectioning container. Empty means addressable.
 *
 * D3 states the rule positively -- "addressable only if every ancestor between it and the
 * document root is a sectioning container" -- so this returns the ancestors that violate it,
 * which is what a not-found error needs in order to explain itself.
 *
 * Taken LITERALLY, and deliberately: a transparent ancestor blocks addressability too, so a
 * heading inside a plain `<div>` or `<blockquote>` is not addressable even though `div` is
 * neither a sectioning container nor an opaque region. That is the safe reading -- a section
 * body starting inside a `<div>` and ending at the next root-level heading would splice
 * across `</div>` and orphan it, which is the same defect the opaque-region rule prevents.
 * Section 6 can relax this by filtering on `containerKind(...) === 'opaque'` instead, but it
 * should be a deliberate change with a fixture behind it, not an accident.
 */
export function blockingAncestorsOf(
  result: TokenizeResult,
  elementIndex: number
): StorageElement[] {
  return ancestorsOf(result, elementIndex).filter(
    (element) => containerKind(element.name) !== 'sectioning'
  );
}

/** True when every ancestor up to the document root is a sectioning container. */
export function isAddressable(result: TokenizeResult, elementIndex: number): boolean {
  return blockingAncestorsOf(result, elementIndex).length === 0;
}

/**
 * Notice codes that mean the source is NOT well-formed storage.
 *
 * `stray-less-than` is deliberately excluded: a bare `<` is ordinary prose (`3 < 4`) and
 * Confluence stores it unescaped, so treating it as fatal would reject legitimate pages. The
 * fatal set is decided here, once, so section 5's submitted-content validation (task 5.4) and
 * section 6's assembled-document validation (task 6.8a) cannot disagree about it.
 */
const FATAL_NOTICE_CODES: ReadonlySet<NoticeCode> = new Set<NoticeCode>([
  'unmatched-close-tag',
  'implicitly-closed-element',
  'unclosed-element-at-eof',
  'unterminated-tag',
  'unterminated-comment',
  'unterminated-cdata',
]);

/** The notices that indicate malformed storage. Empty means well-formed. */
export function wellFormednessErrors(result: TokenizeResult): TokenizerNotice[] {
  return result.notices.filter((notice) => FATAL_NOTICE_CODES.has(notice.code));
}

/** True when the source tokenized as well-formed storage. */
export function isWellFormed(result: TokenizeResult): boolean {
  return wellFormednessErrors(result).length === 0;
}

/** Get an attribute's decoded value, or `undefined`. */
export function attributeValue(element: StorageElement, name: string): string | undefined {
  return element.attributes.find((attribute) => attribute.name === name)?.value;
}

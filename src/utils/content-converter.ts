/**
 * Confluence storage format -> markdown.
 *
 * This is the READ pipeline (design.md D1). It may parse fully, because its output is
 * markdown and nothing is ever written back from it. The edit pipeline is the opposite and
 * lives elsewhere: it must never re-serialize.
 *
 * It replaces a 20-stage chained-regex pipeline that carried two live defects:
 *
 *   1. the `<ol>` branch passed a FUNCTION to `String.replace` whose body was a template
 *      literal containing `$1`. With a function replacement `$1` is not a capture reference,
 *      so the literal characters were emitted and every ordered-list item's text was
 *      destroyed. That output reached real Confluence pages.
 *   2. a global `([^\n])\n([^\n])` -> `$1 $2` rule collapsed every list onto one line.
 *
 * Both are consequences of rewriting a string instead of walking a structure, so the fix is
 * structural: tokenize once, build a node tree, render it. Output is assembled by
 * CONCATENATION ONLY -- no content is ever passed as the replacement argument of
 * `String.replace`, because `$1`, `$&` and `` $` `` are interpreted there whether or not the
 * pattern has capture groups. That is the bug class above, and it is one line away from
 * returning.
 *
 * Text retention is the DEFAULT, not a special case: an element with no explicit handler
 * renders its children. Nothing is dropped for want of a handler.
 */

import {
  MODELLED_ELEMENTS,
  collectConstructs,
  type ConstructInventory,
} from './storage-constructs.js';
import {
  attributeValue,
  decodeEntities,
  tokenize,
  type StorageElement,
  type TokenizeResult,
} from './storage-tokenizer.js';

// ---------------------------------------------------------------------------
// Node tree
// ---------------------------------------------------------------------------

interface TextNode {
  kind: 'text';
  text: string;
}

interface ElementNode {
  kind: 'element';
  name: string;
  element: StorageElement;
  children: Node[];
}

type Node = TextNode | ElementNode;

/**
 * Build a node tree from the token stream.
 *
 * Comments and declarations are dropped -- they carry no reader-visible text. Stray close
 * tags (`elementIndex === -1`) are skipped; the tokenizer has already recorded a notice.
 */
function buildTree(result: TokenizeResult): Node[] {
  const roots: Node[] = [];
  const childrenOf = new Map<number, Node[]>();

  const bucket = (parent: number): Node[] => {
    if (parent === -1) return roots;
    let list = childrenOf.get(parent);
    if (!list) {
      list = [];
      childrenOf.set(parent, list);
    }
    return list;
  };

  const nodes = new Map<number, ElementNode>();

  for (const token of result.tokens) {
    if (token.type === 'comment' || token.type === 'declaration') continue;

    if (token.type === 'text') {
      bucket(token.parentElement).push({ kind: 'text', text: decodeEntities(token.raw) });
      continue;
    }

    if (token.type === 'cdata') {
      let raw = token.raw.slice('<![CDATA['.length);
      if (raw.endsWith(']]>')) raw = raw.slice(0, -']]>'.length);
      bucket(token.parentElement).push({ kind: 'text', text: raw });
      continue;
    }

    if (token.kind === 'close') continue;
    if (token.elementIndex === -1) continue;

    const element = result.elements[token.elementIndex];
    const node: ElementNode = { kind: 'element', name: element.name, element, children: [] };
    nodes.set(element.index, node);
    bucket(token.parentElement).push(node);
  }

  for (const [index, children] of childrenOf) {
    const node = nodes.get(index);
    if (node) node.children = children;
  }

  return roots;
}

// ---------------------------------------------------------------------------
// Element classification
// ---------------------------------------------------------------------------

/**
 * Elements rendered as their own block. Everything here either produces a markdown block
 * construct or is a transparent container whose children are blocks.
 */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  'p',
  'div',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'colgroup',
  'col',
  'pre',
  'hr',
  'ac:layout',
  'ac:layout-section',
  'ac:layout-cell',
  'ac:structured-macro',
  'ac:macro',
  'ac:adf-extension',
  'ac:rich-text-body',
  'ac:plain-text-body',
  'ac:task-list',
  'ac:task',
  'ac:task-body',
]);

/** Elements rendered inline, even when they happen to wrap block content. */
const INLINE_ELEMENTS: ReadonlySet<string> = new Set([
  'a',
  'b',
  'big',
  'br',
  'code',
  'del',
  'em',
  'i',
  'img',
  'ins',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'ac:link',
  'ac:link-body',
  'ac:emoticon',
  'ac:placeholder',
  'ac:parameter',
  'ac:task-id',
  'ac:task-status',
  'ac:image',
]);

/**
 * Every element name the converter handles explicitly, namespaced ones included.
 *
 * Reconciled against `MODELLED_ELEMENTS` by `reconcileModelledElements()`: that set is a
 * promise the renderer has to keep. An element the inventory calls "modelled" but the
 * renderer drops would make `unknownNames` under-report and `lossy` claim "faithful" for a
 * page that lost content.
 */
const HANDLED_ELEMENTS: ReadonlySet<string> = new Set([...BLOCK_ELEMENTS, ...INLINE_ELEMENTS]);

/** Names the converter handles that the inventory must also declare modelled. */
export function handledElementNames(): string[] {
  return [...HANDLED_ELEMENTS].sort();
}

export interface ModelledElementReconciliation {
  /** Declared modelled by the inventory, but with no explicit handler here. */
  unhandled: string[];
  /** Handled here, but not declared modelled by the inventory. */
  undeclared: string[];
}

/**
 * Compare the renderer's explicit coverage with the construct inventory's `MODELLED_ELEMENTS`.
 * Both lists empty means the two agree. Asserted by the test suite rather than thrown at
 * module load, so a drift cannot take the running server down.
 */
export function reconcileModelledElements(): ModelledElementReconciliation {
  const unhandled = [...MODELLED_ELEMENTS].filter((name) => !HANDLED_ELEMENTS.has(name)).sort();
  const undeclared = [...HANDLED_ELEMENTS]
    .filter((name) => !name.includes(':') && !MODELLED_ELEMENTS.has(name))
    .sort();
  return { unhandled, undeclared };
}

function isBlockNode(node: Node): boolean {
  if (node.kind !== 'element') return false;
  if (INLINE_ELEMENTS.has(node.name)) return false;
  if (BLOCK_ELEMENTS.has(node.name)) return true;
  // Unhandled element: block only if it actually contains block content, so an unforeseen
  // inline wrapper stays inline and an unforeseen container still separates its blocks.
  return node.children.some(isBlockNode);
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

/**
 * Sentinel standing in for `<br>` while inline text is being assembled, so the whitespace
 * collapse below cannot swallow a hard break. Stripped from source text on the way in.
 */
const HARD_BREAK = '\u0000';

/** Collapse whitespace runs, honour hard breaks, and trim the block's edges. */
function normalizeInline(text: string): string {
  return text
    .replace(/[\t\r\n ]+/g, ' ')
    .split(HARD_BREAK)
    .map((segment) => segment.trim())
    .join('\n')
    .trim();
}

/** All descendant text, whitespace preserved -- used for `<pre>` and code bodies. */
function rawTextOf(node: Node): string {
  if (node.kind === 'text') return node.text;
  return node.children.map(rawTextOf).join('');
}

function inlineOf(nodes: Node[]): string {
  return nodes.map(renderInline).join('');
}

/**
 * Wrap inline content in an emphasis marker, keeping surrounding whitespace OUTSIDE the
 * markers. `<strong>Deploy </strong>` must not become `**Deploy **`, which no markdown
 * renderer treats as emphasis.
 */
function wrap(nodes: Node[], marker: string): string {
  const inner = inlineOf(nodes);
  const core = inner.trim();
  if (core.length === 0) return inner;
  const leadIndex = inner.indexOf(core);
  const lead = inner.slice(0, leadIndex);
  const trail = inner.slice(leadIndex + core.length);
  return `${lead}${marker}${core}${marker}${trail}`;
}

function renderInline(node: Node): string {
  if (node.kind === 'text') return node.text;

  const { name, element, children } = node;

  switch (name) {
    case 'br':
      return HARD_BREAK;
    case 'strong':
    case 'b':
      return wrap(children, '**');
    case 'em':
    case 'i':
      return wrap(children, '*');
    case 'del':
    case 's':
      return wrap(children, '~~');
    case 'code':
      return `\`${normalizeInline(inlineOf(children))}\``;
    case 'a': {
      const text = inlineOf(children);
      const href = attributeValue(element, 'href');
      return href ? `[${text}](${href})` : text;
    }
    case 'img': {
      const src = attributeValue(element, 'src') ?? '';
      const alt = attributeValue(element, 'alt') ?? '';
      return src ? `![${alt}](${src})` : alt;
    }
    case 'ac:placeholder':
      return wrap(children, '_');
    case 'ac:emoticon':
      return (
        attributeValue(element, 'ac:emoji-shortname') ??
        attributeValue(element, 'ac:emoji-fallback') ??
        (attributeValue(element, 'ac:name') === undefined
          ? ''
          : `:${attributeValue(element, 'ac:name')}:`)
      );
    case 'ac:link': {
      const text = inlineOf(children).trim();
      if (text) return text;
      const title = linkTargetTitle(node);
      return title ?? '';
    }
    case 'ac:image': {
      const filename = attachmentName(node);
      return filename ? `![${filename}]` : '';
    }
    default:
      // Text retention: an element with no handler still renders its children.
      return inlineOf(children);
  }
}

/** `ri:page`/`ri:blog-post`/`ri:space` title attribute on a link target, when present. */
function linkTargetTitle(node: ElementNode): string | undefined {
  for (const child of node.children) {
    if (child.kind !== 'element') continue;
    const title =
      attributeValue(child.element, 'ri:content-title') ??
      attributeValue(child.element, 'ri:space-key');
    if (title) return title;
    const nested = linkTargetTitle(child);
    if (nested) return nested;
  }
  return undefined;
}

function attachmentName(node: ElementNode): string | undefined {
  for (const child of node.children) {
    if (child.kind !== 'element') continue;
    const filename =
      attributeValue(child.element, 'ri:filename') ?? attributeValue(child.element, 'ri:value');
    if (filename) return filename;
    const nested = attachmentName(child);
    if (nested) return nested;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

interface Block {
  /** Lists join tightly to a preceding block inside a list item; other blocks never do. */
  type: 'list' | 'text';
  text: string;
}

interface BlockContext {
  /** Separator placed before a list block. `'\n'` inside a list item, `'\n\n'` elsewhere. */
  listSeparator: '\n' | '\n\n';
}

const ROOT_CONTEXT: BlockContext = { listSeparator: '\n\n' };
const ITEM_CONTEXT: BlockContext = { listSeparator: '\n' };

function joinBlocks(blocks: Block[], context: BlockContext): string {
  let out = '';
  blocks.forEach((block, index) => {
    if (index === 0) {
      out = block.text;
      return;
    }
    out += block.type === 'list' ? context.listSeparator : '\n\n';
    out += block.text;
  });
  return out;
}

/**
 * Render a node list into blocks. Consecutive inline nodes accumulate into an implicit
 * paragraph and flush when a block child appears, which is what keeps whitespace handling
 * structure-aware instead of a global line-joining rule.
 */
function renderBlocks(nodes: Node[]): Block[] {
  const blocks: Block[] = [];
  let inline = '';

  const flush = (): void => {
    const text = normalizeInline(inline);
    inline = '';
    if (text) blocks.push({ type: 'text', text });
  };

  for (const node of nodes) {
    if (node.kind === 'text') {
      inline += node.text;
      continue;
    }
    if (!isBlockNode(node)) {
      inline += renderInline(node);
      continue;
    }
    flush();
    const rendered = renderBlock(node);
    if (rendered.text) blocks.push(rendered);
  }

  flush();
  return blocks;
}

function renderChildren(nodes: Node[], context: BlockContext): string {
  return joinBlocks(renderBlocks(nodes), context);
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split('\n')
    .map((line, index) => {
      if (index === 0) return `${first}${line}`;
      return line.length === 0 ? '' : `${rest}${line}`;
    })
    .join('\n');
}

function renderBlock(node: ElementNode): Block {
  const { name, element, children } = node;

  switch (name) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(name.slice(1));
      const text = singleLine(renderChildren(children, ROOT_CONTEXT));
      return { type: 'text', text: text ? `${'#'.repeat(level)} ${text}` : '' };
    }

    case 'hr':
      return { type: 'text', text: '---' };

    case 'pre': {
      const body = rawTextOf(node).replace(/^\n+|\s+$/g, '');
      return { type: 'text', text: `\`\`\`\n${body}\n\`\`\`` };
    }

    case 'blockquote': {
      const body = renderChildren(children, ROOT_CONTEXT);
      if (!body) return { type: 'text', text: '' };
      return {
        type: 'text',
        text: body
          .split('\n')
          .map((line) => (line.length === 0 ? '>' : `> ${line}`))
          .join('\n'),
      };
    }

    case 'ul':
    case 'ol':
      return { type: 'list', text: renderList(node) };

    case 'dl':
      return { type: 'text', text: renderChildren(children, ROOT_CONTEXT) };
    case 'dt':
      return { type: 'text', text: wrapText(singleLine(renderChildren(children, ROOT_CONTEXT))) };
    case 'dd': {
      const body = renderChildren(children, ROOT_CONTEXT);
      return { type: 'text', text: body ? prefixLines(body, ': ', '  ') : '' };
    }

    case 'table':
      return { type: 'text', text: renderTable(node) };

    case 'ac:structured-macro':
    case 'ac:macro':
    case 'ac:adf-extension':
      return { type: 'text', text: renderMacro(node) };

    case 'ac:plain-text-body': {
      const body = rawTextOf(node).replace(/^\n+|\s+$/g, '');
      return { type: 'text', text: body ? `\`\`\`\n${body}\n\`\`\`` : '' };
    }

    case 'ac:task-list':
      return { type: 'list', text: renderTaskList(node) };

    case 'ac:task':
      return { type: 'list', text: renderTask(node) };

    default:
      // `p`, `div`, layout containers, `ac:rich-text-body`, table parts reached out of
      // context, and every unhandled container: render the children, drop nothing.
      void element;
      return { type: 'text', text: renderChildren(children, ROOT_CONTEXT) };
  }
}

function wrapText(text: string): string {
  return text ? `**${text}**` : '';
}

function singleLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function renderList(node: ElementNode): string {
  const ordered = node.name === 'ol';
  const startAttribute = ordered ? attributeValue(node.element, 'start') : undefined;
  const parsedStart = startAttribute === undefined ? NaN : Number.parseInt(startAttribute, 10);
  let counter = Number.isFinite(parsedStart) && parsedStart > 0 ? parsedStart : 1;

  const lines: string[] = [];
  for (const child of node.children) {
    if (child.kind !== 'element') continue;
    if (child.name !== 'li') {
      // A stray non-`li` child (nested list emitted as a sibling, third-party markup).
      // Render it rather than dropping it.
      const stray = renderChildren([child], ITEM_CONTEXT);
      if (stray) lines.push(stray);
      continue;
    }

    const marker = ordered ? `${counter}. ` : '* ';
    counter += 1;
    const body = renderChildren(child.children, ITEM_CONTEXT);
    lines.push(prefixLines(body, marker, ' '.repeat(marker.length)));
  }

  return lines.join('\n');
}

function renderTaskList(node: ElementNode): string {
  const lines: string[] = [];
  for (const child of node.children) {
    if (child.kind !== 'element') continue;
    const rendered =
      child.name === 'ac:task' ? renderTask(child) : renderChildren([child], ITEM_CONTEXT);
    if (rendered) lines.push(rendered);
  }
  return lines.join('\n');
}

function renderTask(node: ElementNode): string {
  let status = '';
  const bodyNodes: Node[] = [];
  for (const child of node.children) {
    if (child.kind === 'element' && child.name === 'ac:task-status') {
      status = rawTextOf(child).trim().toLowerCase();
      continue;
    }
    if (child.kind === 'element' && child.name === 'ac:task-id') continue;
    bodyNodes.push(child);
  }
  const marker = status === 'complete' ? '- [x] ' : '- [ ] ';
  const body = renderChildren(bodyNodes, ITEM_CONTEXT);
  return prefixLines(body, marker, ' '.repeat(marker.length));
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function collectRows(node: Node, rows: ElementNode[]): void {
  if (node.kind !== 'element') return;
  if (node.name === 'tr') {
    rows.push(node);
    return;
  }
  if (node.name === 'table' && rows.length > 0) return;
  for (const child of node.children) collectRows(child, rows);
}

function cellText(cell: ElementNode): string {
  return singleLine(renderChildren(cell.children, ROOT_CONTEXT)).replace(/\|/g, '\\|');
}

function renderTable(node: ElementNode): string {
  const rows: ElementNode[] = [];
  for (const child of node.children) collectRows(child, rows);

  const grid = rows.map((row) =>
    row.children
      .filter(
        (cell): cell is ElementNode =>
          cell.kind === 'element' && (cell.name === 'td' || cell.name === 'th')
      )
      .map(cellText)
  );

  const caption = node.children.find(
    (child): child is ElementNode => child.kind === 'element' && child.name === 'caption'
  );
  const captionText = caption ? singleLine(renderChildren(caption.children, ROOT_CONTEXT)) : '';

  if (grid.length === 0) {
    const fallback = renderChildren(node.children, ROOT_CONTEXT);
    return captionText && fallback ? `${captionText}\n\n${fallback}` : captionText || fallback;
  }

  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  const pad = (row: string[]): string[] => {
    const padded = row.slice();
    while (padded.length < width) padded.push('');
    return padded;
  };
  const line = (row: string[]): string => `| ${pad(row).join(' | ')} |`;

  const out: string[] = [];
  if (captionText) out.push(captionText, '');
  out.push(line(grid[0]));
  out.push(`| ${new Array(width).fill('---').join(' | ')} |`);
  for (const row of grid.slice(1)) out.push(line(row));
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------

/**
 * `[Confluence Macro: <name>]` is kept deliberately, as a LABEL above the macro's rendered
 * body rather than a substitution for it (design.md D8). Section 5 rejects that string in
 * submitted content as proof of a lossy round trip, so the read output and the write check
 * stay in step. The damage on live pages came from the placeholder REPLACING the macro; the
 * body is now rendered underneath it, so no text is lost.
 */
function renderMacro(node: ElementNode): string {
  const macroName = attributeValue(node.element, 'ac:name') ?? '(unnamed)';

  const parameters: string[] = [];
  const bodyNodes: Node[] = [];
  for (const child of node.children) {
    if (child.kind === 'element' && child.name === 'ac:parameter') {
      // The default (nameless) parameter is common -- `anchor`, `status`. Rendering it as
      // `: value` reads as a broken label, so an unnamed parameter contributes its value only.
      const parameterName = attributeValue(child.element, 'ac:name') ?? '';
      const value = singleLine(inlineOf(child.children));
      if (!parameterName) {
        if (value) parameters.push(value);
      } else {
        parameters.push(value ? `${parameterName}: ${value}` : parameterName);
      }
      continue;
    }
    bodyNodes.push(child);
  }

  const label = `[Confluence Macro: ${macroName}${
    parameters.length > 0 ? ` (${parameters.join(', ')})` : ''
  }]`;
  const body = renderChildren(bodyNodes, ROOT_CONTEXT);
  return body ? `${label}\n\n${body}` : label;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ConversionResult {
  /** Markdown rendering of the storage content. */
  markdown: string;
  /** True when the source contains constructs markdown cannot faithfully represent (D4). */
  lossy: boolean;
  /** What those constructs are -- macros, layouts, other namespaced and unknown elements. */
  constructs: ConstructInventory;
}

/**
 * Seam for the tokenizer and inventory calls.
 *
 * ESM module mocking does not work in this Jest harness (verified: `unstable_mockModule` is
 * a no-op here), so the spec scenario "injected internal failure propagates with its cause"
 * is exercised with `jest.spyOn(internals, 'tokenize')`. Calling through this object keeps
 * the public signatures free of test-only parameters.
 */
export const internals = { tokenize, collectConstructs };

/**
 * Convert storage format to markdown, disclosing whether the rendering is lossy.
 *
 * Throws `TypeError` for a null/undefined/non-string input, and wraps any internal failure in
 * an `Error` carrying `cause`. A partially converted result is never returned as a success.
 * Unrecognized or malformed markup is NOT a failure: it is retained as text.
 */
export function convertStorage(storageFormat: string): ConversionResult {
  if (typeof storageFormat !== 'string') {
    throw new TypeError(
      `convertStorage requires a storage-format string, received ${
        storageFormat === null ? 'null' : typeof storageFormat
      }`
    );
  }

  try {
    const tokenized = internals.tokenize(storageFormat.split(HARD_BREAK).join(''));
    const constructs = internals.collectConstructs(tokenized);
    const markdown = renderChildren(buildTree(tokenized), ROOT_CONTEXT).trim();
    return { markdown, lossy: constructs.lossy, constructs };
  } catch (error) {
    throw new Error('Failed to convert Confluence storage format to markdown', { cause: error });
  }
}

/**
 * Markdown-only convenience over {@link convertStorage}, kept for existing callers.
 * `src/handlers/page-handlers.ts` uses this today; section 4 moves those call sites to
 * `convertStorage` so they can surface `lossy` and the raw storage.
 */
export function convertStorageToMarkdown(storageFormat: string): string {
  return convertStorage(storageFormat).markdown;
}

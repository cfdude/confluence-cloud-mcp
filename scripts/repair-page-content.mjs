#!/usr/bin/env node
/**
 * One-off repair tool for pages this server's OLD converter corrupted before the
 * page-write-safety work landed (see openspec archive: content-format-round-trip).
 *
 * THIS SCRIPT NEVER RUNS AUTOMATICALLY. It is not wired into CI, hooks, or npm scripts.
 * It writes nothing unless `--apply` is passed, and it refuses to run without an explicit
 * `--out` directory to deposit per-page before/after diffs into.
 *
 * THIS REPOSITORY IS PUBLIC. The script therefore carries NO site identifiers of any kind --
 * no page ids, no titles, no domains. Targets come from `--pages` or `--pages-file`, and every
 * diff it writes goes to `--out`, which must be outside the repository.
 *
 * ------------------------------------------------------------------------------------------
 * WHY IT IS BUILT AROUND VERSION HISTORY RATHER THAN AROUND THE CORRUPTED TEXT
 *
 * The corrupted text is not a trustworthy source for reconstruction. The old converter
 * rendered a macro as `[Confluence Macro: NAME (k: v, ...)]`, and that stringification is
 * OFF BY ONE: it paired each parameter NAME with the NEXT parameter's VALUE. A table-of-
 * contents macro whose real parameters are `include=(empty) outline=true indent=(empty)
 * style=none` was rendered `include: true, indent: none`. Rebuilding a macro from the
 * placeholder therefore produces a macro that is confidently wrong.
 *
 * Every repair here is instead sourced from the newest version of the page that carries NO
 * corruption signature at all. That version is ground truth; the placeholder is not.
 *
 * ------------------------------------------------------------------------------------------
 * STRATEGIES, and the conditions each one requires
 *
 *   noop          No corruption signature on the current version. Nothing is written.
 *
 *   macro-splice  Every `<p>[Confluence Macro: NAME ...]</p>` is replaced, in place, by the
 *                 real macro markup lifted VERBATIM from the clean version. Requires, per
 *                 macro NAME, that the number of placeholders in the current body equals the
 *                 number of macros of that name in the clean body. A mismatch means some
 *                 macros vanished with no marker left behind, and there is then no way to know
 *                 which clean macro belongs at which placeholder -- so the page is skipped
 *                 rather than spliced by position.
 *
 *   revert        The clean body is written back wholesale. Requires that the current body
 *                 contributes NO substantive text line the clean body lacks (otherwise the
 *                 revert would delete real work), and that the clean body contains nothing
 *                 matching a redaction signature (see REDACTION_PATTERNS) -- a later edit may
 *                 have deliberately removed client-identifying content, and a revert must not
 *                 quietly republish it.
 *
 *   md2storage    Bare markdown left in the storage field is converted to XHTML in place.
 *                 Requires that NOTHING was destroyed: no macro placeholders, no `$1`
 *                 artifacts, and no drop in macro count against the clean version. Markdown
 *                 leak on its own loses no content -- it only renders as literal characters --
 *                 so converting it is information-preserving. Anything entangled with a
 *                 destroyed construct is skipped instead.
 *
 * Anything that does not qualify for exactly one strategy is SKIPPED and reported. A page left
 * corrupted is recoverable; a page wrongly rewritten may not be.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = (
  process.env.CONFLUENCE_CONFIG_FILE || join(homedir(), '.confluence-config.json')
).replace(/^~/, homedir());

// ---------------------------------------------------------------------------
// Corruption signatures
//
// Deliberately the same shapes the write-safety preflight rejects, so a body this script
// calls "clean" is a body the server would accept. `bullet` is NOT a signature: bare `-`/`*`
// bullets appear on ~360 corpus pages of legitimate human prose (see write-safety.ts).
// ---------------------------------------------------------------------------

const SIGNATURE_PATTERNS = {
  placeholder: /\[Confluence Macro:\s*\S/g,
  artifact: /(?:[0-9]+\.\s*\$1(?![0-9])|<li>\s*\$1\s*<\/li>)/g,
  heading: /(?:^|\n)[ \t]*#{2,6}[ \t]+\S/g,
  emphasis: /\*\*[^\s*][^\n*]*\*\*/g,
  fence: /(?:^|\n)[ \t]*```/g,
};

/**
 * Signature counts for a body.
 *
 * Counted OUTSIDE code regions. `# Result: only port 8080` inside a code macro's CDATA is a
 * shell comment, and `$1::vector` is a Postgres bind parameter; neither is corruption. This
 * mirrors the EXCLUDED_CONTENT_ELEMENTS carve-out in write-safety.ts, and without it six of
 * the pages in scope classify as corrupted when their only "markdown" lives inside a code
 * block.
 */
function signatures(body) {
  const scannable = stripCodeRegions(body);
  const counts = {};
  for (const [name, pattern] of Object.entries(SIGNATURE_PATTERNS)) {
    counts[name] = (scannable.match(pattern) || []).length;
  }
  counts.macros = (body.match(/<ac:structured-macro/g) || []).length;
  return counts;
}

const isClean = (s) =>
  s.placeholder === 0 && s.artifact === 0 && s.heading === 0 && s.emphasis === 0 && s.fence === 0;

/** Blank out CDATA sections and `<code>`/`<pre>` bodies, preserving byte length. */
function stripCodeRegions(body) {
  return body.replace(
    /<!\[CDATA\[[\s\S]*?\]\]>|<code\b[^>]*>[\s\S]*?<\/code>|<pre\b[^>]*>[\s\S]*?<\/pre>/g,
    (m) => ' '.repeat(m.length)
  );
}

// ---------------------------------------------------------------------------
// Text projection, used for both the revert gate and the post-write verification
// ---------------------------------------------------------------------------

const INLINE_ELEMENTS = new Set([
  'a', 'abbr', 'b', 'big', 'br', 'cite', 'code', 'del', 'em', 'i', 'ins', 'kbd', 'q', 's',
  'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var',
]);

const NAMED_ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&ndash;': '-', '&mdash;': '-', '&rsquo;': "'", '&lsquo;': "'",
  '&rdquo;': '"', '&ldquo;': '"', '&hellip;': '...',
};

/**
 * Substantive text lines of a body, normalized for comparison.
 *
 * Only BLOCK elements break a line -- an inline `<strong>` must not split a sentence, or the
 * same sentence written as markdown and as XHTML compares as two different things and every
 * diff drowns in noise. Markdown markers and list ordinals are stripped so `**X**: y`,
 * `* **X**: y` and `<li><strong>X</strong>: y</li>` all normalize to `x: y`.
 *
 * Markdown markers are deleted rather than replaced with a space: `**X**: y` must normalize
 * to exactly what `<strong>X</strong>: y` normalizes to, and substituting a space leaves
 * `X : y` on one side only, which reports every emphasized label as lost text.
 *
 * Lines shorter than five words are dropped: they are headings and table cells, which churn
 * for formatting reasons, and keeping them makes the comparison less reliable, not more.
 */
function textLines(body) {
  let text = body.replace(/<!\[CDATA\[/g, '\n').replace(/\]\]>/g, '\n');
  text = text.replace(/<(\/?)([a-zA-Z][-a-zA-Z0-9:]*)[^>]*>/g, (_m, _slash, name) =>
    INLINE_ELEMENTS.has(name.toLowerCase()) ? '' : '\n'
  );
  for (const [entity, char] of Object.entries(NAMED_ENTITIES)) text = text.split(entity).join(char);
  text = text.replace(/&[a-zA-Z]+;/g, ' ').replace(/&#\d+;/g, ' ');

  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/[*_`#>|]/g, '')
      .replace(/^[\s\-+.\d)]+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (line.split(' ').length >= 5) lines.push(line);
  }
  return lines;
}

/**
 * Content a revert would RE-INTRODUCE that has since been deleted.
 *
 * A revert is not only "does current add anything" -- it also resurrects everything the clean
 * version had. At least one page in the observed corpus was edited with the message "scope
 * contamination cleanup - removed client-specific data source examples per scope violation
 * audit", so reverting past that edit would republish data somebody deliberately deleted.
 * These patterns are broad on purpose: they BLOCK a revert, they do not silently alter it, and
 * the operator is shown every matching line.
 */
const REDACTION_PATTERNS = [
  { id: 'nmls', pattern: /\bnmls\b/i },
  { id: 'money-scale', pattern: /\$\s?[\d,.]+\s?[mkb]\b/i },
  { id: 'long-number', pattern: /\b\d{5,}\b/ },
];

function redactionHits(lines) {
  const hits = [];
  for (const line of lines) {
    for (const { id, pattern } of REDACTION_PATTERNS) {
      if (pattern.test(line)) {
        hits.push({ id, line });
        break;
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Strategy: macro-splice
// ---------------------------------------------------------------------------

/** Every top-level `<ac:structured-macro>` in a body, with its name and exact source text. */
function extractMacros(body) {
  const macros = [];
  const open = /<ac:structured-macro\b[^>]*?ac:name="([^"]+)"[^>]*?(\/?)>/g;
  let match;
  while ((match = open.exec(body)) !== null) {
    const [full, name, selfClosing] = match;
    if (selfClosing === '/') {
      macros.push({ name, source: full, start: match.index, end: match.index + full.length });
      continue;
    }
    // Scan forward for the matching close, counting nested structured-macros.
    const scan = /<ac:structured-macro\b[^>]*?(\/?)>|<\/ac:structured-macro>/g;
    scan.lastIndex = match.index;
    let depth = 0;
    let cursor;
    while ((cursor = scan.exec(body)) !== null) {
      if (cursor[0].startsWith('</')) {
        depth -= 1;
        if (depth === 0) break;
      } else if (cursor[1] !== '/') {
        depth += 1;
      }
    }
    if (cursor === null || depth !== 0) continue;
    const end = cursor.index + cursor[0].length;
    macros.push({ name, source: body.slice(match.index, end), start: match.index, end });
    open.lastIndex = end;
  }
  return macros;
}

/**
 * A placeholder paragraph: `<p>[Confluence Macro: NAME (...)]</p>`, or the bare text.
 *
 * The name is read from the placeholder because it is the ONE piece of the placeholder that
 * survived the off-by-one stringification intact. The parameters are ignored entirely.
 */
const PLACEHOLDER_BLOCK =
  /(?:<p>\s*)?\[Confluence Macro:\s*([A-Za-z0-9_-]+)(?:\s*\([^\n]*?\))?\](?:\s*<\/p>)?/g;

function macroSplice(current, clean) {
  const cleanMacros = extractMacros(clean);
  const placeholders = [];
  let match;
  PLACEHOLDER_BLOCK.lastIndex = 0;
  while ((match = PLACEHOLDER_BLOCK.exec(current)) !== null) {
    placeholders.push({ name: match[1], start: match.index, end: match.index + match[0].length });
  }
  if (placeholders.length === 0) return { ok: false, reason: 'no macro placeholder found' };

  // Per NAME, the counts must agree. Splicing by position across a count mismatch attaches
  // the wrong macro body to the wrong location, and a body-bearing macro (code, info, panel)
  // makes that a silent content swap rather than a visible error.
  const byName = (list) =>
    list.reduce((acc, item) => ((acc[item.name] = (acc[item.name] || 0) + 1), acc), {});
  const wanted = byName(placeholders);
  const available = byName(cleanMacros);
  for (const [name, count] of Object.entries(wanted)) {
    const have = available[name] || 0;
    if (have !== count) {
      return {
        ok: false,
        reason:
          `macro "${name}": ${count} placeholder(s) in the current body but ${have} macro(s) ` +
          `in the clean version -- cannot tell which clean macro belongs at which placeholder`,
      };
    }
  }

  const queues = {};
  for (const macro of cleanMacros) (queues[macro.name] ||= []).push(macro.source);

  let out = '';
  let cursor = 0;
  for (const placeholder of placeholders) {
    out += current.slice(cursor, placeholder.start);
    out += queues[placeholder.name].shift();
    cursor = placeholder.end;
  }
  out += current.slice(cursor);
  return { ok: true, content: out, restored: placeholders.length };
}

// ---------------------------------------------------------------------------
// Strategy: md2storage
// ---------------------------------------------------------------------------

const VOID_ELEMENTS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'area']);

/**
 * Convert bare markdown in a storage body to XHTML, leaving everything else byte-identical.
 *
 * The corrupted bodies are MIXED: a later edit often re-added proper XHTML (tables, code
 * macros) while the markdown text around it stayed. So this is not a markdown parser applied
 * to the whole document -- it is a line scanner that only ever touches lines it can prove are
 * outside any markup, and copies every other line through untouched.
 *
 * Three passthrough conditions, all load-bearing:
 *   - inside a CDATA section (a code macro's body; `# comment` there is a shell comment)
 *   - inside an open XHTML element (a table row, a list already in storage format)
 *   - a line that itself starts a tag at depth zero
 *
 * Entities in the source are ALREADY escaped (`&lt;200ms`). They are emitted untouched;
 * re-escaping would turn them into `&amp;lt;`.
 */
function markdownToStorage(body) {
  const lines = body.split('\n');
  const out = [];
  let depth = 0;
  let inCdata = false;
  let listKind = null; // 'ul' | 'ol' | null
  let paragraph = [];
  // Blank lines seen while a list is open. The corrupted bodies separate EVERY list item with
  // a blank line, so closing the list on a blank line would emit one single-item list per
  // bullet -- and for an ordered list, restart the numbering at 1 on every item. They are held
  // here until the next content line says whether the list continues.
  let pendingBlanks = 0;

  const closeParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushBlanks = () => {
    for (let i = 0; i < pendingBlanks; i += 1) out.push('');
    pendingBlanks = 0;
  };
  /** Settle any open list against the block that is about to be emitted. */
  const settle = (nextKind) => {
    if (listKind && listKind !== nextKind) {
      out.push(`</${listKind}>`);
      listKind = null;
    }
    flushBlanks();
    if (nextKind && !listKind) {
      out.push(`<${nextKind}>`);
      listKind = nextKind;
    }
  };

  for (const line of lines) {
    if (inCdata) {
      out.push(line);
      if (line.includes(']]>')) inCdata = false;
      continue;
    }

    const trimmed = line.trim();

    if (trimmed === '') {
      closeParagraph();
      if (listKind) pendingBlanks += 1;
      else out.push('');
      continue;
    }

    // A line that is inside markup, or opens markup, is copied verbatim.
    if (depth > 0 || trimmed.startsWith('<')) {
      closeParagraph();
      settle(null);
      out.push(line);
      const delta = tagDelta(line);
      depth += delta.depth;
      if (delta.opensCdata) inCdata = true;
      continue;
    }

    const heading = /^(#{1,6})[ \t]+(.*)$/.exec(trimmed);
    if (heading) {
      closeParagraph();
      settle(null);
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      continue;
    }

    const bullet = /^[-*+][ \t]+(.*)$/.exec(trimmed);
    if (bullet) {
      closeParagraph();
      settle('ul');
      out.push(`<li>${inline(bullet[1].trim())}</li>`);
      continue;
    }

    const ordered = /^\d+\.[ \t]+(.*)$/.exec(trimmed);
    if (ordered) {
      closeParagraph();
      settle('ol');
      out.push(`<li>${inline(ordered[1].trim())}</li>`);
      continue;
    }

    if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      closeParagraph();
      settle(null);
      out.push('<hr />');
      continue;
    }

    settle(null);
    paragraph.push(trimmed);
  }
  closeParagraph();
  settle(null);
  return out.join('\n');
}

/** Net element-depth change contributed by one line, plus whether it opens a CDATA section. */
function tagDelta(line) {
  let depth = 0;
  const tag = /<(\/?)([a-zA-Z][-a-zA-Z0-9:]*)[^>]*?(\/?)>/g;
  let match;
  while ((match = tag.exec(line)) !== null) {
    const [, closing, name, selfClosing] = match;
    if (VOID_ELEMENTS.has(name.toLowerCase()) || selfClosing === '/') continue;
    depth += closing === '/' ? -1 : 1;
  }
  const opensCdata = line.includes('<![CDATA[') && !line.includes(']]>');
  return { depth: Math.max(depth, -Infinity), opensCdata };
}

/**
 * Inline markdown. Strictly `**strong**`, `*em*` and `` `code` `` -- nothing else.
 *
 * `*em*` is matched only when the asterisks are not adjacent to a word character, so it cannot
 * swallow a bullet marker or the `*` in `SELECT *`. No link or image handling: the pages this
 * tool is aimed at contain none, and untested conversion code is worse than none.
 */
function inline(text) {
  return text
    .replace(/\*\*([^\s*][^*]*?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![*\w])\*([^\s*][^*\n]*?)\*(?![*\w])/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

// ---------------------------------------------------------------------------
// Confluence access
// ---------------------------------------------------------------------------

function loadInstance(name) {
  if (!existsSync(CONFIG_PATH)) throw new Error(`No Confluence config at ${CONFIG_PATH}`);
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const instance = config.instances?.[name];
  if (!instance) {
    throw new Error(`Unknown instance "${name}". Configured: ${Object.keys(config.instances || {}).join(', ')}`);
  }
  const auth = Buffer.from(`${instance.email}:${instance.apiToken}`).toString('base64');
  return { domain: instance.domain, headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } };
}

async function getJson(site, path) {
  const response = await fetch(`https://${site.domain}${path}`, { headers: site.headers });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`GET ${path} -> ${response.status}: ${detail}`);
  }
  return response.json();
}

async function fetchCurrent(site, pageId) {
  const page = await getJson(site, `/wiki/api/v2/pages/${pageId}?body-format=storage`);
  return { title: page.title, version: page.version?.number, body: page.body?.storage?.value ?? '' };
}

/**
 * The NEWEST version of the page carrying no corruption signature.
 *
 * Newest rather than oldest: an earlier version is likelier to predate legitimate edits, and
 * reverting to it would delete work. Walking backwards from the current version stops at the
 * last known-good state.
 */
async function findCleanVersion(site, pageId) {
  const listing = await getJson(site, `/wiki/api/v2/pages/${pageId}/versions?limit=100`);
  const numbers = (listing.results || []).map((v) => v.number).sort((a, b) => b - a);
  for (const number of numbers) {
    let body;
    try {
      const historical = await getJson(
        site,
        `/wiki/rest/api/content/${pageId}?status=historical&version=${number}&expand=body.storage`
      );
      body = historical.body?.storage?.value ?? '';
    } catch {
      continue; // The current version is not addressable as historical on every site.
    }
    if (body && isClean(signatures(body))) return { number, body };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function plan(current, clean) {
  const currentSig = signatures(current.body);
  if (isClean(currentSig)) {
    return { strategy: 'noop', reason: 'no corruption signature on the current version', currentSig };
  }
  if (!clean) {
    return { strategy: 'skip', reason: 'no version without a corruption signature exists in history', currentSig };
  }

  const cleanSig = signatures(clean.body);
  const cleanLines = new Set(textLines(clean.body));
  const currentLines = new Set(textLines(current.body));
  const onlyInCurrent = [...currentLines].filter((l) => !cleanLines.has(l));
  const onlyInClean = [...cleanLines].filter((l) => !currentLines.has(l));
  const context = { currentSig, cleanSig, cleanVersion: clean.number, onlyInCurrent, onlyInClean };

  const destroyed = currentSig.placeholder > 0 || currentSig.artifact > 0;
  const macrosLost = cleanSig.macros - currentSig.macros;

  // Revert first: it is the only strategy that recovers text the converter DESTROYED, and it
  // is lossless by construction when the current body adds nothing.
  if (onlyInCurrent.length === 0) {
    const hits = redactionHits(onlyInClean);
    if (hits.length > 0) {
      return {
        ...context,
        strategy: 'skip',
        reason:
          `a revert would re-introduce ${hits.length} line(s) matching a redaction signature ` +
          `(${[...new Set(hits.map((h) => h.id))].join(', ')}) that a later edit removed`,
        redactions: hits,
      };
    }
    return { ...context, strategy: 'revert', reason: `current version adds no text absent from v${clean.number}` };
  }

  // Placeholders, but the counts line up per name and nothing else is wrong: splice.
  if (currentSig.placeholder > 0 && currentSig.artifact === 0 && currentSig.heading === 0 &&
      currentSig.emphasis === 0 && currentSig.fence === 0) {
    const spliced = macroSplice(current.body, clean.body);
    if (!spliced.ok) return { ...context, strategy: 'skip', reason: spliced.reason };
    return { ...context, strategy: 'macro-splice', reason: `restored ${spliced.restored} macro(s) from v${clean.number}`, content: spliced.content };
  }

  if (destroyed) {
    return {
      ...context,
      strategy: 'skip',
      reason:
        `content was destroyed (${currentSig.placeholder} macro placeholder(s), ` +
        `${currentSig.artifact} "$1" artifact(s)) AND the current version adds ` +
        `${onlyInCurrent.length} line(s) the clean version lacks -- neither a revert nor an ` +
        `in-place conversion can recover it without guessing`,
    };
  }

  if (macrosLost > 0) {
    return {
      ...context,
      strategy: 'skip',
      reason:
        `${macrosLost} macro(s) present in v${clean.number} are gone from the current version ` +
        `with no placeholder marking where they were -- converting the markdown would make ` +
        `that loss permanent and unmarked`,
    };
  }

  const converted = markdownToStorage(current.body);
  return { ...context, strategy: 'md2storage', reason: 'markdown leak only; no construct was destroyed', content: converted };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function loadPreflight() {
  const built = join(REPO_ROOT, 'build', 'utils', 'write-safety.js');
  if (!existsSync(built)) throw new Error(`Run "npm run build" first -- ${built} is missing.`);
  return import(built);
}

/** Text the repair must not have dropped: every substantive line of the pre-repair body. */
function lostText(before, after) {
  const afterLines = new Set(textLines(after));
  return textLines(before).filter((l) => !afterLines.has(l));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { apply: false, pages: [] };
  for (const arg of argv) {
    const [key, value] = arg.startsWith('--') ? arg.slice(2).split('=') : [null, null];
    if (key === 'instance') args.instance = value;
    else if (key === 'pages') args.pages = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'pages-file') args.pagesFile = value;
    else if (key === 'out') args.out = value;
    else if (key === 'apply') args.apply = true;
    else if (key === 'dry-run') args.apply = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.instance) throw new Error('--instance=<key> is required');
  if (!args.out) throw new Error('--out=<dir> is required (put it OUTSIDE this repository)');
  if (args.pagesFile) {
    args.pages = readFileSync(args.pagesFile.replace(/^~/, homedir()), 'utf8')
      .split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  }
  if (args.pages.length === 0) throw new Error('--pages=<id,id,...> or --pages-file=<path> is required');
  if (resolve(args.out).startsWith(REPO_ROOT)) {
    throw new Error('--out must be outside the repository: this repo is public and diffs contain page content');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const site = loadInstance(args.instance);
  const { preflight } = await loadPreflight();
  mkdirSync(args.out, { recursive: true });

  console.log(args.apply ? '*** APPLY MODE -- pages will be written ***' : 'DRY RUN -- nothing will be written');
  console.log(`instance=${args.instance} pages=${args.pages.length} out=${args.out}\n`);

  const results = [];
  for (const pageId of args.pages) {
    const record = { pageId };
    try {
      const current = await fetchCurrent(site, pageId);
      record.versionBefore = current.version;
      record.title = current.title;

      const clean = await findCleanVersion(site, pageId);
      const decision = plan(current, clean);
      record.strategy = decision.strategy;
      record.reason = decision.reason;
      record.cleanVersion = decision.cleanVersion ?? null;
      record.signatures = decision.currentSig;

      const nextBody =
        decision.strategy === 'revert' ? clean.body
        : decision.strategy === 'md2storage' || decision.strategy === 'macro-splice' ? decision.content
        : null;

      if (nextBody !== null) {
        // The repaired body must satisfy the server's own preflight UNAIDED. An override flag
        // would only prove the checks can be silenced, not that the repair is correct.
        const failure = await preflight({ content: nextBody, currentContent: current.body });
        if (failure) {
          record.strategy = 'skip';
          record.reason = `repaired content still fails preflight (${failure.check}): ${failure.message}`;
        } else {
          record.lostText = lostText(current.body, nextBody);
          record.remainingSignatures = signatures(nextBody);
        }
      }

      writeFileSync(
        join(args.out, `${args.instance}-${pageId}.diff.txt`),
        renderDiff(args.instance, pageId, current, clean, decision, nextBody)
      );

      if (args.apply && nextBody !== null && record.strategy !== 'skip') {
        const { handleUpdateConfluencePage } = await import(
          join(REPO_ROOT, 'build', 'handlers', 'page-handlers.js')
        );
        await handleUpdateConfluencePage({
          instance: args.instance,
          pageId,
          content: nextBody,
          expectedVersion: current.version,
        });
        const after = await fetchCurrent(site, pageId);
        record.versionAfter = after.version;
        record.verified = isClean(signatures(after.body)) && lostText(current.body, after.body).length === 0;
      }
    } catch (error) {
      record.strategy = 'error';
      record.reason = error instanceof Error ? error.message : String(error);
    }
    results.push(record);
    console.log(
      `${pageId}  v${record.versionBefore ?? '?'}${record.versionAfter ? `->v${record.versionAfter}` : ''}  ` +
      `${String(record.strategy).padEnd(13)} ${record.reason}` +
      (record.lostText?.length ? `  [!! ${record.lostText.length} text line(s) would be lost]` : '')
    );
  }

  writeFileSync(join(args.out, `${args.instance}-report.json`), JSON.stringify(results, null, 2));
  console.log(`\nreport: ${join(args.out, `${args.instance}-report.json`)}`);
}

function renderDiff(instance, pageId, current, clean, decision, nextBody) {
  const parts = [
    `instance: ${instance}`,
    `page:     ${pageId}`,
    `title:    ${current.title}`,
    `version:  ${current.version}`,
    `clean:    ${decision.cleanVersion ?? '(none found)'}`,
    `strategy: ${decision.strategy}`,
    `reason:   ${decision.reason}`,
    `signatures (current): ${JSON.stringify(decision.currentSig)}`,
    '',
  ];
  if (decision.redactions?.length) {
    parts.push(`=== REDACTION-SIGNATURE LINES BLOCKING A REVERT (${decision.redactions.length}) ===`);
    parts.push(...decision.redactions.map((h) => `[${h.id}] ${h.line}`), '');
  }
  if (decision.onlyInCurrent) {
    parts.push(`=== TEXT ONLY IN CURRENT (${decision.onlyInCurrent.length}) ===`, ...decision.onlyInCurrent, '');
    parts.push(`=== TEXT ONLY IN CLEAN v${decision.cleanVersion} (${decision.onlyInClean.length}) ===`, ...decision.onlyInClean, '');
  }
  if (nextBody !== null) {
    parts.push(`=== TEXT LOST BY THE REPAIR (must be empty) ===`, ...lostText(current.body, nextBody), '');
    parts.push('=== BEFORE ===', current.body, '', '=== AFTER ===', nextBody, '');
  }
  return parts.join('\n');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

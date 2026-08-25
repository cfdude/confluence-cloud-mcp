#!/usr/bin/env node
/**
 * Fixture capture for the content-format-round-trip change (tasks 1.2 / 1.3 / 1.3a).
 *
 * THIS REPOSITORY IS PUBLIC. Two hard rules are enforced here, not left to discipline:
 *
 *   1. Capture is restricted to the `onvex` site. Any other configured instance is REFUSED
 *      before the API token is read and before any network call is made. There is no
 *      `defaultInstance` fallback: `--instance` must be supplied and must be `onvex`.
 *   2. Everything that reaches `__tests__/fixtures/` is sanitized. Human words, figures,
 *      URLs, and identity-bearing attribute values are replaced with deterministic synthetic
 *      equivalents. Markup structure -- element names, attribute names, attribute order,
 *      nesting, macros, layouts, entities, CDATA delimiters -- is preserved verbatim,
 *      because structure is the only thing the fixtures test.
 *
 * Usage:
 *   node scripts/capture-fixtures.mjs --instance onvex --page 131189 --inspect
 *   node scripts/capture-fixtures.mjs --instance onvex --page 131189 --out layout --shape "ac:layout"
 *
 * `--inspect` prints a STRUCTURAL summary only (element counts, shape flags). It never
 * prints page prose, so picking a source page does not leak real content into a transcript.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SANITIZER_VERSION = 1;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = join(REPO_ROOT, '__tests__', 'fixtures');
const MANIFEST_PATH = join(FIXTURE_DIR, 'manifest.json');
const CONFIG_PATH = (process.env.CONFLUENCE_CONFIG_FILE || join(homedir(), '.confluence-config.json'))
  .replace(/^~/, homedir());

/** The ONLY instance key and domain this script will ever talk to. */
const ALLOWED_INSTANCE = 'onvex';
const ALLOWED_DOMAIN = 'onvex.atlassian.net';
/** Belt-and-braces: a config edit must not be able to sneak Highway content past the allowlist. */
const DENIED_DOMAIN_SUBSTRINGS = ['listreports', 'highway'];

// ---------------------------------------------------------------------------
// Synthetic vocabulary. Deterministic: the same source word always maps to the
// same synthetic word, so repeated headings stay repeated and re-capturing a
// page produces a byte-identical fixture.
// ---------------------------------------------------------------------------

const WORD_POOL = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'zeta',
  'eta',
  'theta',
  'iota',
  'kappa',
  'lambda',
  'mu',
  'nu',
  'xi',
  'omicron',
  'pi',
  'rho',
  'sigma',
  'tau',
  'upsilon',
  'phi',
  'chi',
  'psi',
  'omega',
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'sed',
  'eiusmod',
  'tempor',
  'incididunt',
  'labore',
  'magna',
  'aliqua',
  'veniam',
  'quis',
  'nostrud',
  'ullamco',
  'laboris',
  'aliquip',
  'commodo',
  'consequat',
  'duis',
  'aute',
  'irure',
  'reprehenderit',
  'voluptate',
  'cillum',
  'fugiat',
  'nulla',
  'pariatur',
  'excepteur',
  'sint',
  'occaecat',
  'cupidatat',
  'proident',
  'sunt',
  'culpa',
  'officia',
  'deserunt',
  'mollit',
];

function hashInt(value) {
  const digest = createHash('sha256').update(value).digest();
  return digest.readUInt32BE(0);
}

function matchCase(source, replacement) {
  if (source === source.toUpperCase() && /[A-Z]/.test(source)) return replacement.toUpperCase();
  if (source[0] === source[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function syntheticWord(word) {
  const pick = WORD_POOL[hashInt(`w:${word.toLowerCase()}`) % WORD_POOL.length];
  return matchCase(word, pick);
}

function syntheticDigits(digits) {
  const seeded = String(hashInt(`d:${digits}`)).padStart(digits.length, '7');
  return seeded.slice(0, digits.length);
}

/**
 * Sanitize a run of human text. Entity references, whitespace, and punctuation are
 * structural here and pass through untouched; only letter-runs and digit-runs are replaced.
 */
function sanitizeText(text) {
  return text.replace(/&#?\w+;|[A-Za-z]+|[0-9]+/g, (token) => {
    if (token.startsWith('&')) return token; // entity reference -- opaque
    if (/^[0-9]+$/.test(token)) return syntheticDigits(token);
    return syntheticWord(token);
  });
}

/**
 * Attribute values split into two classes:
 *  - structural (kept verbatim): ac:name, ac:schema-version, ac:macro-id, ac:local-id,
 *    class, style, colspan, data-layout, ... -- these describe markup, not content.
 *  - identity/URL bearing (sanitized): these carry real page titles, filenames, user ids,
 *    and links. Constraint "no real page text in a fixture" wins over "attributes verbatim".
 * Attribute NAMES, ORDER, COUNT, and quoting are always preserved.
 */
const URL_ATTRS = new Set(['href', 'src', 'ri:value']);
const TEXT_ATTRS = new Set([
  'ri:content-title',
  'ri:space-key',
  'ri:filename',
  'ri:account-id',
  'ri:userkey',
  'ri:username',
  'ri:alias',
  'ac:alt',
  'ac:anchor',
  'ac:caption',
  'alt',
  'title',
  'data-linked-resource-default-alias',
  'data-linked-resource-id',
  'data-linked-resource-container-id',
]);
/** Values that describe rendering or identity of markup, never human content. */
const STRUCTURAL_ATTRS = new Set([
  'class',
  'style',
  'colspan',
  'rowspan',
  'start',
  'ac:name',
  'ac:schema-version',
  'ac:macro-id',
  'ac:local-id',
  'ac:type',
  'ac:align',
  'ac:width',
  'ac:height',
  'ac:layout',
  'ac:breakout-mode',
  'ac:card-appearance',
  'ac:original-width',
  'ac:original-height',
  'ac:emoji-id',
  'ac:emoji-shortname',
  'ac:emoji-fallback',
  'ri:version-at-save',
  'data-layout',
  'data-card-appearance',
  'data-highlight-colour',
  'data-table-width',
  'data-width',
  'data-original-width',
  'data-original-height',
]);

function sanitizeAttrValue(name, value) {
  const lower = name.toLowerCase();
  if (URL_ATTRS.has(lower)) {
    return `https://example.com/${hashInt(`u:${value}`).toString(16)}`;
  }
  if (TEXT_ATTRS.has(lower)) return sanitizeText(value);
  if (STRUCTURAL_ATTRS.has(lower)) return value;
  // Catch-all for attributes neither list anticipates: anything that reads like a phrase
  // (whitespace plus two or more words) is treated as human content and sanitized. This is
  // how `ac:alt` was caught during capture; the explicit lists above are the fast path.
  const words = value.match(/[A-Za-z]{2,}/g) ?? [];
  if (/\s/.test(value) && words.length >= 2) return sanitizeText(value);
  return value;
}

// ---------------------------------------------------------------------------
// Minimal storage-format scanner. Deliberately NOT a real parser -- task 2 owns
// the tokenizer decision. This only needs to split markup from text so that the
// sanitizer never touches markup and the inspector can count shapes.
// ---------------------------------------------------------------------------

/** @returns {Array<{type:'text'|'comment'|'cdata'|'decl'|'tag', raw:string, name?:string, kind?:'open'|'close'|'self'}>} */
export function scan(input) {
  const tokens = [];
  let i = 0;
  let textStart = 0;

  const flushText = (end) => {
    if (end > textStart) tokens.push({ type: 'text', raw: input.slice(textStart, end) });
  };

  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) break;

    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt);
      const stop = end === -1 ? input.length : end + 3;
      flushText(lt);
      tokens.push({ type: 'comment', raw: input.slice(lt, stop) });
      i = textStart = stop;
      continue;
    }
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt);
      const stop = end === -1 ? input.length : end + 3;
      flushText(lt);
      tokens.push({ type: 'cdata', raw: input.slice(lt, stop) });
      i = textStart = stop;
      continue;
    }
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
      i = lt + 1; // a bare '<' in text
      continue;
    }

    // Find the closing '>' of this tag, skipping quoted attribute values.
    let j = lt + 1;
    let quote = null;
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
      name: nameMatch[1],
      kind: raw.startsWith('</') ? 'close' : raw.endsWith('/>') ? 'self' : 'open',
    });
    i = textStart = stop;
  }
  flushText(input.length);
  return tokens;
}

function sanitizeTag(raw) {
  // Replace only the value inside each name="value" pair; everything else is copied verbatim.
  return raw.replace(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g, (all, name, q, value) => {
    const next = sanitizeAttrValue(name, value);
    return next === value ? all : `${name}=${q}${next}${q}`;
  });
}

export function sanitizeStorage(storage) {
  return scan(storage)
    .map((token) => {
      switch (token.type) {
        case 'text':
          return sanitizeText(token.raw);
        case 'cdata':
          return `<![CDATA[${sanitizeText(token.raw.slice(9, -3))}]]>`;
        case 'comment':
          return `<!--${sanitizeText(token.raw.slice(4, token.raw.endsWith('-->') ? -3 : undefined))}-->`;
        case 'tag':
          return sanitizeTag(token.raw);
        default:
          return token.raw;
      }
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Structural inspection (no prose ever printed)
// ---------------------------------------------------------------------------

const VOID_ELEMENTS = new Set(['br', 'hr', 'img', 'col', 'input', 'meta', 'link']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

export function inspectStructure(storage) {
  const counts = new Map();
  const stack = [];
  const shapes = {
    orderedList: false,
    nestedList: false,
    table: false,
    structuredMacro: false,
    layout: false,
    macroInsideListItem: false,
    headingInRichTextBody: false,
    headingInTableCell: false,
    headingInLayoutCell: false,
    headingCount: 0,
    headingsAllInLayoutCells: false,
  };
  let headingsInLayoutCells = 0;

  for (const token of scan(storage)) {
    if (token.type !== 'tag') continue;
    const name = token.name.toLowerCase();
    if (token.kind === 'close') {
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k] === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);

    const inside = (tag) => stack.includes(tag);
    if (name === 'ol') shapes.orderedList = true;
    if (name === 'table') shapes.table = true;
    if (name === 'ac:structured-macro') {
      shapes.structuredMacro = true;
      if (inside('li')) shapes.macroInsideListItem = true;
    }
    if (name === 'ac:layout') shapes.layout = true;
    if ((name === 'ul' || name === 'ol') && inside('li')) shapes.nestedList = true;
    if (HEADINGS.has(name)) {
      shapes.headingCount += 1;
      if (inside('ac:rich-text-body')) shapes.headingInRichTextBody = true;
      if (inside('td') || inside('th')) shapes.headingInTableCell = true;
      if (inside('ac:layout-cell')) {
        shapes.headingInLayoutCell = true;
        headingsInLayoutCells += 1;
      }
    }

    if (token.kind === 'open' && !VOID_ELEMENTS.has(name)) stack.push(name);
  }

  shapes.headingsAllInLayoutCells =
    shapes.headingCount > 0 && headingsInLayoutCells === shapes.headingCount;
  return { counts: Object.fromEntries([...counts].sort()), shapes };
}

// ---------------------------------------------------------------------------
// Instance gating -- runs before the token is read and before any network call
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
}

function resolveOnvexInstance(instanceKey) {
  if (!instanceKey) {
    fail('--instance is required. There is no default: only `onvex` may ever be captured.');
  }
  if (instanceKey !== ALLOWED_INSTANCE) {
    fail(
      `instance "${instanceKey}" is not capturable. This repository is PUBLIC; fixtures may ` +
        `only be captured from "${ALLOWED_INSTANCE}". No credentials were read and no request was made.`
    );
  }
  if (!existsSync(CONFIG_PATH)) fail(`no config at ${CONFIG_PATH}`);

  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const entry = config?.instances?.[instanceKey];
  if (!entry) fail(`instance "${instanceKey}" is not present in ${CONFIG_PATH}`);

  const domain = String(entry.domain ?? '').toLowerCase();
  if (domain !== ALLOWED_DOMAIN) {
    fail(
      `instance "${instanceKey}" resolves to domain "${domain}", not "${ALLOWED_DOMAIN}". ` +
        `Refusing to capture. No request was made.`
    );
  }
  for (const denied of DENIED_DOMAIN_SUBSTRINGS) {
    if (domain.includes(denied)) {
      fail(`domain "${domain}" matches denied substring "${denied}". No request was made.`);
    }
  }
  if (!entry.email || !entry.apiToken) fail(`instance "${instanceKey}" has no basic-auth credentials`);
  return { domain: entry.domain, email: entry.email, apiToken: entry.apiToken };
}

async function fetchStorage(instance, pageId) {
  const auth = Buffer.from(`${instance.email}:${instance.apiToken}`).toString('base64');
  const url = `https://${instance.domain}/wiki/api/v2/pages/${encodeURIComponent(pageId)}?body-format=storage`;
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`GET pages/${pageId} failed: ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  const storage = body?.body?.storage?.value;
  if (typeof storage !== 'string' || storage.length === 0) {
    throw new Error(`page ${pageId} returned no storage body`);
  }
  return storage;
}

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return { sanitizerVersion: SANITIZER_VERSION, fixtures: [] };
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

function writeManifest(manifest) {
  manifest.fixtures.sort((a, b) => a.file.localeCompare(b.file));
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'inspect') args.inspect = true;
    else args[key] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const instance = resolveOnvexInstance(args.instance);

  if (!args.page) fail('--page <id> is required');
  const storage = await fetchStorage(instance, args.page);

  if (args.inspect) {
    const { counts, shapes } = inspectStructure(storage);
    console.log(JSON.stringify({ page: args.page, bytes: storage.length, shapes, counts }, null, 2));
    return;
  }

  if (!args.out) fail('--out <fixture-name> is required (or pass --inspect)');
  const sanitized = sanitizeStorage(storage);
  if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });

  const file = `${args.out}.xhtml`;
  writeFileSync(join(FIXTURE_DIR, file), `${sanitized.trim()}\n`, 'utf8');

  const manifest = readManifest();
  manifest.sanitizerVersion = SANITIZER_VERSION;
  // Published so the fixture test can assert sanitization positively -- every word in a
  // captured fixture must come from this pool -- without duplicating the pool in the test.
  manifest.syntheticVocabulary = [...WORD_POOL].sort();
  manifest.fixtures = manifest.fixtures.filter((f) => f.file !== file);
  manifest.fixtures.push({
    file,
    origin: 'captured',
    instance: ALLOWED_INSTANCE,
    sourcePageId: String(args.page),
    shape: args.shape ?? '',
    sanitized: true,
  });
  writeManifest(manifest);

  const { shapes } = inspectStructure(sanitized);
  console.log(
    JSON.stringify({ wrote: file, bytes: sanitized.length, shapes }, null, 2)
  );
}

// Only run the CLI when executed directly, so the scanner/sanitizer can be imported by
// one-off verification scripts without triggering a capture.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

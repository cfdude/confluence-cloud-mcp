/**
 * Retrieval response shape shared by `get_confluence_page` and `find_confluence_page`
 * (spec: page-content-retrieval; design.md D7, D11).
 *
 * The two handlers build IDENTICAL payloads from the same `Page`, which is what makes the
 * spec's "finding a page by title returns the same representations" requirement structural
 * rather than a pair of implementations that have to be kept in step by hand.
 *
 * Backward compatibility (D7): markdown stays under the key `content` -- the key the handlers
 * used before this capability existed -- and raw storage goes under the distinct key
 * `storage`. `format` defaults to `both`, so a caller that knows nothing about the parameter
 * keeps its markdown AND gains the storage it needs to write back correctly.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { convertStorage } from './content-converter.js';
import { collectHeadingOutline } from './heading-outline.js';
import { tokenize } from './storage-tokenizer.js';
import type { Page } from '../types/index.js';

export const PAGE_FORMATS = ['markdown', 'storage', 'both'] as const;
export type PageFormat = (typeof PAGE_FORMATS)[number];

export const DEFAULT_PAGE_FORMAT: PageFormat = 'both';

/** One heading as retrieval reports it. `HeadingEntry.elementIndex` is internal and dropped. */
export interface OutlineEntry {
  level: number;
  text: string;
  occurrence: number;
  addressable: boolean;
}

export interface PageRetrievalPayload {
  instance: string;
  title: string;
  /** Echoed so a caller can tell which content keys to expect. */
  format: PageFormat;
  /** The version a write must build on. Also present, unchanged, at `metadata.version`. */
  version: number;
  /** Markdown rendering. Absent when `format` is `storage`. */
  content?: string;
  /** Raw storage, byte-for-byte as Confluence returned it. Absent when `format` is `markdown`. */
  storage?: string;
  /** Whether the markdown rendering is lossy. Absent when `format` is `storage`. */
  lossy?: boolean;
  /** Every heading on the page, in document order. Present for every format. */
  outline: OutlineEntry[];
  metadata: {
    id: string;
    spaceId: string;
    status: string;
    version: number;
    createdAt: string;
    lastModified: string;
    parentId: string | null;
    url: string;
  };
}

/**
 * Validate the caller's `format`, defaulting an ABSENT value to `both`.
 *
 * Only an absent key defaults. `''` and `null` are rejected rather than defaulted: an agent
 * passing an empty string is a realistic client bug, and silently treating it as `both` hides
 * it. Call this BEFORE any Confluence request so a rejected format returns no page content.
 */
export function resolvePageFormat(value: unknown): PageFormat {
  if (value === undefined) return DEFAULT_PAGE_FORMAT;
  if (typeof value === 'string' && (PAGE_FORMATS as readonly string[]).includes(value)) {
    return value as PageFormat;
  }
  throw new McpError(
    ErrorCode.InvalidParams,
    `Invalid "format" value ${JSON.stringify(value)}. Accepted values: ${PAGE_FORMATS.join(', ')}.`
  );
}

/**
 * Render markdown, turning a converter failure into an actionable error.
 *
 * The converter throws rather than returning a partial result (task 3.7). Storage is right
 * there and unaffected by a rendering bug, so the message says so; the original failure is
 * kept as `cause` rather than serialized into the error payload.
 */
function renderMarkdown(storage: string, pageId: string): { markdown: string; lossy: boolean } {
  try {
    const { markdown, lossy } = convertStorage(storage);
    return { markdown, lossy };
  } catch (error) {
    const failure = new McpError(
      ErrorCode.InternalError,
      `Failed to render page ${pageId} as markdown: ${
        error instanceof Error ? error.message : String(error)
      }. Retry with format: 'storage' to retrieve the raw content.`
    );
    (failure as Error).cause = error;
    throw failure;
  }
}

/**
 * Build the retrieval response for a fetched page.
 *
 * `storage` is taken verbatim from the API response and never reformatted, re-indented, or
 * entity-normalized. A page with no body yields `''`, not `undefined`: `JSON.stringify` drops
 * undefined keys, and a `format: 'storage'` response missing its `storage` key would violate
 * the spec.
 */
export function buildPageRetrievalPayload(
  page: Page,
  instanceName: string,
  format: PageFormat
): PageRetrievalPayload {
  const storage = page.body?.storage?.value ?? '';

  const outline: OutlineEntry[] = collectHeadingOutline(tokenize(storage)).map(
    ({ level, text, occurrence, addressable }) => ({ level, text, occurrence, addressable })
  );

  const rendered = format === 'storage' ? undefined : renderMarkdown(storage, page.id);

  return {
    instance: instanceName,
    title: page.title,
    format,
    version: page.version.number,
    ...(rendered === undefined ? {} : { content: rendered.markdown }),
    ...(format === 'markdown' ? {} : { storage }),
    ...(rendered === undefined ? {} : { lossy: rendered.lossy }),
    outline,
    metadata: {
      id: page.id,
      spaceId: page.spaceId,
      status: page.status.value,
      version: page.version.number,
      createdAt: page.createdAt,
      lastModified: page.version.createdAt,
      parentId: page.parentId || null,
      url: page._links.webui,
    },
  };
}

/** One row of a space listing. Deliberately carries no page body (design.md D11). */
export interface PageListEntry {
  id: string;
  title: string;
  status: string;
  parentId: string | null;
  createdAt: string;
  version: number;
  _links: { webui: string };
}

/**
 * Map a page to its listing row.
 *
 * `list_confluence_pages` is explicitly OUT of scope for the `format` parameter (D11): a
 * listing should not carry full bodies, and returning them would make every space listing an
 * unbounded response. This mapper exists so that guarantee is a checked property rather than
 * an implementation detail of the handler -- it drops `body` even when the client fetched it.
 */
export function buildPageListEntry(page: Page): PageListEntry {
  return {
    id: page.id,
    title: page.title,
    status: page.status.value,
    parentId: page.parentId || null,
    createdAt: page.createdAt,
    version: page.version.number,
    _links: { webui: page._links.webui },
  };
}

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import { ConfluenceError } from '../types/index.js';
import { cachePageInstance } from '../utils/instance-cache.js';
import { withConfluenceContext } from '../utils/tool-wrapper.js';
import type { ToolArgs } from '../utils/tool-wrapper.js';

interface SearchPagesArgs extends ToolArgs {
  cql: string;
  limit?: number;
  cursor?: string;
}

/**
 * Read the `cursor` query parameter out of a pagination link.
 *
 * The v1 search API returns `_links.next` as a RELATIVE path, so `new URL(next)` throws
 * `Invalid URL` — which discarded an otherwise successful search response. The base below is
 * a parsing scaffold only; it is never used to issue a request. Absolute links keep working
 * because a base is ignored when the input is already absolute.
 *
 * Returns undefined when there is no next link, when the link is unparseable, or when it
 * carries no cursor — pagination degrades rather than failing the whole search.
 */
export function extractCursor(next: string | undefined | null): string | undefined {
  if (!next) return undefined;
  try {
    return new URL(next, 'https://placeholder.invalid').searchParams.get('cursor') ?? undefined;
  } catch {
    return undefined;
  }
}

export async function handleSearchConfluencePages(args: SearchPagesArgs) {
  return withConfluenceContext(
    args,
    { requiresSpace: false },
    async (toolArgs, { client, instanceName }) => {
      try {
        const results = await client.searchConfluenceContent(toolArgs.cql, {
          limit: toolArgs.limit,
          start: toolArgs.cursor ? parseInt(toolArgs.cursor) : undefined,
        });

        // Cache page instances for search results
        for (const result of results.results) {
          if (result.content?.spaceId) {
            await cachePageInstance(result.content.id, result.content.spaceId, instanceName);
          }
        }

        // Transform to simplified format
        const simplified = {
          instance: instanceName,
          cql: toolArgs.cql,
          results: results.results.map((result) => ({
            id: result.content.id,
            type: result.content.type,
            title: result.content.title,
            spaceId: result.content.spaceId,
            excerpt: result.excerpt,
            lastModified: result.lastModified,
            url: result.content._links.webui,
          })),
          // `_links.next` from the v1 search API is RELATIVE (e.g. `/rest/api/search?...`),
          // and `new URL()` throws `Invalid URL` on a relative string with no base. That threw
          // away every search response after the request had already succeeded. The base is
          // only needed to make the string parseable; we read the query off it and discard it.
          cursor: extractCursor(results._links.next),
          hasMore: !!results._links.next,
          size: results.size,
          totalSize: results.size,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(simplified, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error(
          'Error searching content:',
          error instanceof Error ? error.message : String(error)
        );
        if (error instanceof ConfluenceError && error.code === 'SEARCH_FAILED') {
          throw new McpError(ErrorCode.InvalidRequest, `Invalid CQL query: ${error.message}`);
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to search content: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

interface GetLabelsArgs extends ToolArgs {
  pageId: string;
}

export async function handleGetConfluenceLabels(args: GetLabelsArgs) {
  return withConfluenceContext(
    args,
    { requiresPage: true },
    async (toolArgs, { client, instanceName }) => {
      try {
        const labels = await client.getConfluenceLabels(toolArgs.pageId);

        // Transform to simplified format
        const simplified = {
          instance: instanceName,
          pageId: toolArgs.pageId,
          labels: labels.results.map((label) => ({
            id: label.id,
            name: label.name,
            prefix: label.prefix,
          })),
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(simplified, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error(
          'Error getting labels:',
          error instanceof Error ? error.message : String(error)
        );
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get labels: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

interface AddLabelArgs extends ToolArgs {
  pageId: string;
  label: string;
  prefix?: string;
}

export async function handleAddConfluenceLabel(args: AddLabelArgs) {
  return withConfluenceContext(
    args,
    { requiresPage: true },
    async (toolArgs, { client, instanceName }) => {
      try {
        const result = await client.addConfluenceLabel(
          toolArgs.pageId,
          toolArgs.label,
          toolArgs.prefix || 'global'
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  instance: instanceName,
                  message: 'Label added successfully',
                  pageId: toolArgs.pageId,
                  label: {
                    id: result.id,
                    name: result.name,
                    prefix: result.prefix,
                    createdAt: result.createdAt,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        console.error(
          'Error adding label:',
          error instanceof Error ? error.message : String(error)
        );
        if (error instanceof ConfluenceError) {
          if (error.code === 'LABEL_EXISTS') {
            throw new McpError(ErrorCode.InvalidRequest, `Label already exists: ${error.message}`);
          } else if (error.code === 'INVALID_LABEL') {
            throw new McpError(ErrorCode.InvalidParams, `Invalid label format: ${error.message}`);
          }
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to add label: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

interface RemoveLabelArgs extends ToolArgs {
  pageId: string;
  label: string;
}

export async function handleRemoveConfluenceLabel(args: RemoveLabelArgs) {
  return withConfluenceContext(
    args,
    { requiresPage: true },
    async (toolArgs, { client, instanceName }) => {
      try {
        await client.removeConfluenceLabel(toolArgs.pageId, toolArgs.label);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  instance: instanceName,
                  message: 'Label removed successfully',
                  pageId: toolArgs.pageId,
                  label: toolArgs.label,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        console.error(
          'Error removing label:',
          error instanceof Error ? error.message : String(error)
        );
        if (error instanceof ConfluenceError && error.code === 'LABEL_EXISTS') {
          throw new McpError(ErrorCode.InvalidRequest, `Label not found: ${error.message}`);
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to remove label: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

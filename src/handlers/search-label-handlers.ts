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
          cursor: results._links.next
            ? new URL(results._links.next).searchParams.get('cursor')
            : undefined,
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

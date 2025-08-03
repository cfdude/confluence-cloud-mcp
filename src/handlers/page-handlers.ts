import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import { convertStorageToMarkdown } from '../utils/content-converter.js';
import { cachePageInstance } from '../utils/instance-cache.js';
import { withConfluenceContext } from '../utils/tool-wrapper.js';
import type { ToolArgs } from '../utils/tool-wrapper.js';

interface ListPagesArgs extends ToolArgs {
  spaceId: string;
  limit?: number;
  cursor?: string;
  sort?: 'created-date' | '-created-date' | 'modified-date' | '-modified-date' | 'title' | '-title';
  status?: 'current' | 'archived' | 'draft' | 'trashed';
}

export async function handleListConfluencePages(args: ListPagesArgs) {
  return withConfluenceContext(
    args,
    { requiresSpace: true },
    async (toolArgs, { client, instanceName }) => {
      try {
        const pages = await client.getConfluencePages(toolArgs.spaceId, {
          limit: toolArgs.limit,
          cursor: toolArgs.cursor,
          sort: toolArgs.sort,
          status: toolArgs.status,
        });

        // Cache page instances for future lookups
        for (const page of pages.results) {
          await cachePageInstance(page.id, toolArgs.spaceId, instanceName);
        }

        // Transform to minimal format with cursor pagination support
        const simplified = {
          instance: instanceName,
          spaceId: toolArgs.spaceId,
          results: pages.results.map((page) => ({
            id: page.id,
            title: page.title,
            status: page.status.value,
            parentId: page.parentId || null,
            createdAt: page.createdAt,
            version: page.version.number,
            _links: {
              webui: page._links.webui,
            },
          })),
          cursor: pages._links.next?.split('cursor=')[1],
          limit: pages.limit,
          size: pages.size,
          hasMore: !!pages._links.next,
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
          'Error listing pages:',
          error instanceof Error ? error.message : String(error)
        );
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list pages: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

interface GetPageArgs extends ToolArgs {
  pageId: string;
}

export async function handleGetConfluencePage(args: GetPageArgs) {
  return withConfluenceContext(
    args,
    { requiresPage: true },
    async (toolArgs, { client, instanceName }) => {
      try {
        const page = await client.getConfluencePage(toolArgs.pageId);

        // Cache the page instance
        await cachePageInstance(page.id, page.spaceId, instanceName);

        // Convert content to markdown
        const markdownContent = page.body?.storage?.value
          ? convertStorageToMarkdown(page.body.storage.value)
          : '';

        // Return simplified format with markdown
        const simplified = {
          instance: instanceName,
          title: page.title,
          content: markdownContent,
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
          'Error getting page:',
          error instanceof Error ? error.message : String(error)
        );
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get page: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

interface FindPageArgs extends ToolArgs {
  title: string;
  spaceId?: string;
}

export async function handleFindConfluencePage(args: FindPageArgs) {
  return withConfluenceContext(
    args,
    { requiresSpace: false },
    async (toolArgs, { client, instanceName }) => {
      try {
        const page = await client.findConfluencePageByTitle(toolArgs.title, toolArgs.spaceId);

        // Cache the page instance
        await cachePageInstance(page.id, page.spaceId, instanceName);

        // Convert content to markdown
        const markdownContent = page.body?.storage?.value
          ? convertStorageToMarkdown(page.body.storage.value)
          : '';

        // Return simplified format
        const simplified = {
          instance: instanceName,
          title: page.title,
          content: markdownContent,
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
          'Error finding page:',
          error instanceof Error ? error.message : String(error)
        );
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to find page: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

interface CreatePageArgs extends ToolArgs {
  spaceId: string;
  title: string;
  content: string;
  parentId?: string;
}

export async function handleCreateConfluencePage(args: CreatePageArgs) {
  return withConfluenceContext(
    args,
    { requiresSpace: true },
    async (toolArgs, { client, instanceName, spaceConfig }) => {
      try {
        // Apply default parent page if configured and not provided
        const parentId = toolArgs.parentId || spaceConfig?.defaultParentPageId;

        const page = await client.createConfluencePage(
          toolArgs.spaceId,
          toolArgs.title,
          toolArgs.content,
          parentId
        );

        // Cache the new page instance
        await cachePageInstance(page.id, toolArgs.spaceId, instanceName);

        // Apply default labels if configured
        if (spaceConfig?.defaultLabels && spaceConfig.defaultLabels.length > 0) {
          for (const label of spaceConfig.defaultLabels) {
            try {
              await client.addConfluenceLabel(page.id, label, 'global');
            } catch (error) {
              console.warn(`Failed to add default label "${label}":`, error);
            }
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  instance: instanceName,
                  message: 'Page created successfully',
                  pageId: page.id,
                  title: page.title,
                  spaceId: page.spaceId,
                  version: page.version.number,
                  url: page._links.webui,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        console.error(
          'Error creating page:',
          error instanceof Error ? error.message : String(error)
        );
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to create page: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

interface UpdatePageArgs extends ToolArgs {
  pageId: string;
  title: string;
  content: string;
  version: number;
}

export async function handleUpdateConfluencePage(args: UpdatePageArgs) {
  return withConfluenceContext(
    args,
    { requiresPage: true },
    async (toolArgs, { client, instanceName }) => {
      try {
        const page = await client.updateConfluencePage(
          toolArgs.pageId,
          toolArgs.title,
          toolArgs.content,
          toolArgs.version
        );

        // Update cache with the latest instance info
        await cachePageInstance(page.id, page.spaceId, instanceName);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  instance: instanceName,
                  message: 'Page updated successfully',
                  pageId: page.id,
                  title: page.title,
                  version: page.version.number,
                  url: page._links.webui,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        console.error(
          'Error updating page:',
          error instanceof Error ? error.message : String(error)
        );
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to update page: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

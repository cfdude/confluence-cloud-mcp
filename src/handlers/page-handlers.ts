import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { ConfluenceClient } from "../client/confluence-client.js";
import { ConfluenceError } from "../types/index.js";
import type { Page, PaginatedResponse, SimplifiedPage } from "../types/index.js";
import { convertStorageToMarkdown } from "../utils/content-converter.js";

function convertToSimplifiedPage(page: Page, markdownContent: string): SimplifiedPage {
  return {
    title: page.title,
    content: markdownContent,
    metadata: {
      id: page.id,
      spaceId: page.spaceId,
      version: page.version.number,
      lastModified: page.version.createdAt,
      url: page._links.webui
    }
  };
}

export async function handleListConfluencePages(
  client: ConfluenceClient,
  args: {
    spaceId: string;
    limit?: number;
    cursor?: string;
    sort?: 'created-date' | '-created-date' | 'modified-date' | '-modified-date' | 'title' | '-title';
    status?: 'current' | 'archived' | 'draft' | 'trashed';
  }
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  try {
    if (!args.spaceId) {
      throw new McpError(ErrorCode.InvalidParams, "spaceId is required");
    }

    const pages = await client.getConfluencePages(args.spaceId, {
      limit: args.limit,
      cursor: args.cursor,
      sort: args.sort,
      status: args.status
    });
    
    const simplified = {
      results: pages.results.map(page => ({
        id: page.id,
        title: page.title,
        spaceId: page.spaceId,
        version: page.version.number,
        parentId: page.parentId || null,
        status: page.status.value,
        _links: page._links
      })),
      cursor: pages._links.next?.split('cursor=')[1],
      limit: pages.limit,
      size: pages.size,
      hasMore: !!pages._links.next
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(simplified, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error listing pages:", error instanceof Error ? error.message : String(error));
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to list pages: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function handleGetConfluencePage(
  client: ConfluenceClient,
  args: { pageId: string }
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  try {
    if (!args.pageId) {
      throw new McpError(ErrorCode.InvalidParams, "pageId is required");
    }

    try {
      const page = await client.getConfluencePage(args.pageId);
      
      // Check if we have content to convert
      if (page.body?.storage?.value) {
        // Convert to markdown and return simplified page
        const markdownContent = convertStorageToMarkdown(page.body.storage.value);
        const simplified = convertToSimplifiedPage(page, markdownContent);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(simplified, null, 2),
            },
          ],
        };
      } else {
        // Return page metadata without content if no body available
        const simplified = {
          id: page.id,
          title: page.title,
          spaceId: page.spaceId,
          version: page.version.number,
          parentId: page.parentId || null,
          content: null,
          status: page.status.value,
          url: page._links.webui
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(simplified, null, 2),
            },
          ],
        };
      }
    } catch (error) {
      if (error instanceof ConfluenceError) {
        switch (error.code) {
          case 'PAGE_NOT_FOUND':
            throw new McpError(ErrorCode.InvalidParams, "Page not found");
          case 'INSUFFICIENT_PERMISSIONS':
            throw new McpError(ErrorCode.InvalidRequest, "Insufficient permissions to access page");
          case 'EMPTY_CONTENT':
            throw new McpError(ErrorCode.InternalError, "Page content is empty");
          default:
            throw new McpError(ErrorCode.InternalError, error.message);
        }
      }
      throw error;
    }
  } catch (error) {
    console.error("Error getting page:", error instanceof Error ? error.message : String(error));
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to get page: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function handleFindConfluencePage(
  client: ConfluenceClient,
  args: { title: string; spaceId?: string }
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  try {
    if (!args.title) {
      throw new McpError(ErrorCode.InvalidParams, "title is required");
    }

    const pages = await client.searchPageByName(args.title, args.spaceId);
    
    if (pages.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No pages found with title "${args.title}"`
      );
    }

    if (pages.length > 1) {
      // If multiple pages found, return a list of matches
      const matches = pages.map(page => ({
        id: page.id,
        title: page.title,
        spaceId: page.spaceId,
        url: page._links.webui
      }));
      
      throw new McpError(
        ErrorCode.InvalidParams,
        `Multiple pages found with title "${args.title}". Please use get_confluence_page with one of these IDs: ${JSON.stringify(matches)}`
      );
    }

    // Get the full page content for the single match
    const page = await client.getConfluencePage(pages[0].id);
    
    if (!page.body?.storage?.value) {
      throw new McpError(
        ErrorCode.InternalError,
        "Page content is empty"
      );
    }

    const markdownContent = convertStorageToMarkdown(page.body.storage.value);
    const simplified = convertToSimplifiedPage(page, markdownContent);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(simplified, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error getting page by name:", error instanceof Error ? error.message : String(error));
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to get page: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function handleCreateConfluencePage(
  client: ConfluenceClient,
  args: { spaceId: string; title: string; content: string; parentId?: string }
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  try {
    if (!args.spaceId || !args.title || !args.content) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "spaceId, title, and content are required"
      );
    }

    const page = await client.createConfluencePage(
      args.spaceId,
      args.title,
      args.content,
      args.parentId
    );

    const simplified = {
      id: page.id,
      title: page.title,
      version: page.version.number,
      status: page.status.value,
      url: page._links.webui
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(simplified, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error creating page:", error instanceof Error ? error.message : String(error));
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to create page: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function handleUpdateConfluencePage(
  client: ConfluenceClient,
  args: { pageId: string; title: string; content: string; version: number }
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  try {
    if (!args.pageId || !args.title || !args.content || args.version === undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "pageId, title, content, and version are required"
      );
    }

    const page = await client.updateConfluencePage(
      args.pageId,
      args.title,
      args.content,
      args.version
    );

    const simplified = {
      id: page.id,
      title: page.title,
      version: page.version.number,
      status: page.status.value,
      url: page._links.webui
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(simplified, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error updating page:", error instanceof Error ? error.message : String(error));
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to update page: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
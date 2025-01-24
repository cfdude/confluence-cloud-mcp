import { ConfluenceClient } from "../client/confluence-client.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ConfluenceError, type Label, type SearchResult } from "../types/index.js";

export async function handleSearchConfluenceContent(
  client: ConfluenceClient,
  args: { query: string; limit?: number; start?: number }
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  try {
    if (!args.query) {
      throw new McpError(ErrorCode.InvalidParams, "query is required");
    }

    const results = await client.searchConfluenceContent(args.query, args.limit, args.start);
    const simplified = {
      results: results.results.map(result => ({
        id: result.content.id,
        title: result.content.title,
        type: result.content.type,
        url: result.url,
        excerpt: result.excerpt || null
      })),
      next: results._links.next ? true : false
    };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(simplified),
        },
      ],
    };
  } catch (error) {
    console.error("Error searching content:", error instanceof Error ? error.message : String(error));
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to search content: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function handleGetConfluenceLabels(
  client: ConfluenceClient,
  args: { pageId: string }
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  try {
    if (!args.pageId) {
      throw new McpError(ErrorCode.InvalidParams, "pageId is required");
    }

    const labels = await client.getConfluenceLabels(args.pageId);
    const simplified = {
      labels: labels.results.map((label: Label) => ({
        id: label.id,
        name: label.name
      })),
      next: labels._links.next ? true : false
    };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(simplified),
        },
      ],
    };
  } catch (error) {
    console.error("Error getting labels:", error instanceof Error ? error.message : String(error));
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to get labels: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function handleAddConfluenceLabel(
  client: ConfluenceClient,
  args: { pageId: string; label: string }
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  try {
    if (!args.pageId || !args.label) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "pageId and label are required"
      );
    }

    // Validate label format
    if (!/^[a-zA-Z0-9-_]+$/.test(args.label)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Label must contain only letters, numbers, hyphens, and underscores"
      );
    }

    // First check if the page exists and is accessible
    try {
      await client.getConfluencePage(args.pageId);
    } catch (error: unknown) {
      if (error instanceof ConfluenceError) {
        switch (error.code) {
          case 'PAGE_NOT_FOUND':
            throw new McpError(ErrorCode.InvalidParams, "Page not found");
          case 'INSUFFICIENT_PERMISSIONS':
            throw new McpError(ErrorCode.InvalidRequest, "Insufficient permissions to access page");
          default:
            throw new McpError(ErrorCode.InternalError, error.message);
        }
      }
      throw error;
    }

    const label = await client.addConfluenceLabel(args.pageId, args.label);
    const simplified = {
      success: true,
      label: {
        id: label.id,
        name: label.name,
        prefix: label.prefix || null,
        createdDate: label.createdDate || null
      },
      message: `Successfully added label '${args.label}' to page ${args.pageId}`
    };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(simplified),
        },
      ],
    };
  } catch (error: unknown) {
    console.error("Error adding label:", error instanceof Error ? error.message : String(error));
    
    if (error instanceof McpError) {
      throw error;
    }

    // Handle specific HTTP errors from the Confluence API
    if (error instanceof ConfluenceError) {
      switch (error.code) {
        case 'LABEL_EXISTS':
          throw new McpError(ErrorCode.InvalidRequest, `Label '${args.label}' already exists on this page`);
        case 'INVALID_LABEL':
          throw new McpError(ErrorCode.InvalidParams, "Invalid label format");
        case 'PERMISSION_DENIED':
          throw new McpError(ErrorCode.InvalidRequest, "You don't have permission to add labels to this page");
        default:
          throw new McpError(ErrorCode.InternalError, `Failed to add label: ${error.message}`);
      }
    }

    throw new McpError(
      ErrorCode.InternalError,
      `Failed to add label: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function handleRemoveConfluenceLabel(
  client: ConfluenceClient,
  args: { pageId: string; label: string }
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  try {
    if (!args.pageId || !args.label) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "pageId and label are required"
      );
    }

    // First check if the page exists and is accessible
    try {
      await client.getConfluencePage(args.pageId);
    } catch (error: unknown) {
      if (error instanceof ConfluenceError) {
        switch (error.code) {
          case 'PAGE_NOT_FOUND':
            throw new McpError(ErrorCode.InvalidParams, "Page not found");
          case 'INSUFFICIENT_PERMISSIONS':
            throw new McpError(ErrorCode.InvalidRequest, "Insufficient permissions to access page");
          default:
            throw new McpError(ErrorCode.InternalError, error.message);
        }
      }
      throw error;
    }

    await client.removeConfluenceLabel(args.pageId, args.label);
    const simplified = {
      success: true,
      message: `Successfully removed label '${args.label}' from page ${args.pageId}`,
      details: {
        pageId: args.pageId,
        label: args.label,
        operation: 'remove'
      }
    };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(simplified),
        },
      ],
    };
  } catch (error: unknown) {
    console.error("Error removing label:", error instanceof Error ? error.message : String(error));
    
    if (error instanceof McpError) {
      throw error;
    }

    // Handle specific HTTP errors from the Confluence API
    if (error instanceof ConfluenceError) {
      switch (error.code) {
        case 'PAGE_NOT_FOUND':
          throw new McpError(ErrorCode.InvalidParams, "Page not found");
        case 'PERMISSION_DENIED':
          throw new McpError(ErrorCode.InvalidRequest, "You don't have permission to remove labels from this page");
        default:
          throw new McpError(ErrorCode.InternalError, `Failed to remove label: ${error.message}`);
      }
    }

    throw new McpError(
      ErrorCode.InternalError,
      `Failed to remove label: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

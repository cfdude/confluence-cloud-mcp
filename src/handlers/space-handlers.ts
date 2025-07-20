import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { ConfluenceClient } from "../client/confluence-client.js";
import type { Space, PaginatedResponse } from "../types/index.js";

export async function handleListConfluenceSpaces(
  client: ConfluenceClient,
  args: {
    limit?: number;
    cursor?: string;
    sort?: 'name' | '-name' | 'key' | '-key';
    status?: 'current' | 'archived';
  }
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  try {
    const spaces = await client.getConfluenceSpaces({
      limit: args.limit,
      cursor: args.cursor,
      sort: args.sort,
      status: args.status
    });
    
    // Transform to minimal format with cursor pagination support
    const simplified = {
      results: spaces.results.map(space => ({
        id: space.id,
        name: space.name,
        key: space.key,
        status: space.status,
        type: space.type,
        description: space.description?.plain || null,
        _links: {
          webui: space._links.webui
        }
      })),
      cursor: spaces._links.next?.split('cursor=')[1],
      limit: spaces.limit,
      size: spaces.size,
      hasMore: !!spaces._links.next
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
    console.error("Error listing spaces:", error instanceof Error ? error.message : String(error));
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to list spaces: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function handleGetConfluenceSpace(
  client: ConfluenceClient,
  args: { spaceId: string }
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  try {
    if (!args.spaceId) {
      throw new McpError(ErrorCode.InvalidParams, "spaceId is required");
    }

    const space = await client.getConfluenceSpace(args.spaceId);
    
    // Transform to minimal format
    const simplified = {
      id: space.id,
      name: space.name,
      key: space.key,
      status: space.status,
      type: space.type,
      description: space.description?.plain || null,
      homepage: space.homepageId,
      url: space._links.webui
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
    console.error("Error getting space:", error instanceof Error ? error.message : String(error));
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to get space: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
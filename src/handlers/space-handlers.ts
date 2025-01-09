import { ConfluenceClient } from "../client/confluence-client.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Space, PaginatedResponse } from "../types/index.js";

export async function handleListConfluenceSpaces(
  client: ConfluenceClient,
  args: { limit?: number; start?: number }
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  try {
    const spaces = await client.getConfluenceSpaces(args.limit, args.start);
    // Transform to minimal format
    const simplified = {
      results: spaces.results.map(space => ({
        id: space.id,
        name: space.name,
        key: space.key,
        status: space.status
      })),
      next: spaces._links.next ? true : false
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
      homepage: space.homepageId,
      url: space._links.webui
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

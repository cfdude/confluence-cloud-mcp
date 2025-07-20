import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { withConfluenceContext } from "../utils/tool-wrapper.js";
import type { ToolArgs } from "../utils/tool-wrapper.js";

interface ListSpacesArgs extends ToolArgs {
  limit?: number;
  cursor?: string;
  sort?: 'name' | '-name' | 'key' | '-key';
  status?: 'current' | 'archived';
}

export async function handleListConfluenceSpaces(args: ListSpacesArgs) {
  return withConfluenceContext(
    args,
    { requiresSpace: false },
    async (toolArgs, { client, instanceName }) => {
      try {
        const spaces = await client.getConfluenceSpaces({
          limit: toolArgs.limit,
          cursor: toolArgs.cursor,
          sort: toolArgs.sort,
          status: toolArgs.status
        });
        
        // Transform to minimal format with cursor pagination support
        const simplified = {
          instance: instanceName,
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
  );
}

interface GetSpaceArgs extends ToolArgs {
  spaceId: string;
}

export async function handleGetConfluenceSpace(args: GetSpaceArgs) {
  return withConfluenceContext(
    args,
    { requiresSpace: true },
    async (toolArgs, { client, instanceName }) => {
      try {
        if (!toolArgs.spaceId) {
          throw new McpError(ErrorCode.InvalidParams, "spaceId is required");
        }

        const space = await client.getConfluenceSpace(toolArgs.spaceId);
        
        // Transform to minimal format
        const simplified = {
          instance: instanceName,
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
  );
}
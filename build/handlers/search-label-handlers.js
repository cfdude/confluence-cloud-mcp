import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
export async function handleSearchConfluenceContent(client, args) {
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
    }
    catch (error) {
        console.error("Error searching content:", error);
        throw new McpError(ErrorCode.InternalError, `Failed to search content: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export async function handleGetConfluenceLabels(client, args) {
    try {
        if (!args.pageId) {
            throw new McpError(ErrorCode.InvalidParams, "pageId is required");
        }
        const labels = await client.getConfluenceLabels(args.pageId);
        const simplified = {
            labels: labels.results.map((label) => ({
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
    }
    catch (error) {
        console.error("Error getting labels:", error);
        throw new McpError(ErrorCode.InternalError, `Failed to get labels: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export async function handleAddConfluenceLabel(client, args) {
    try {
        if (!args.pageId || !args.label) {
            throw new McpError(ErrorCode.InvalidParams, "pageId and label are required");
        }
        const label = await client.addConfluenceLabel(args.pageId, args.label);
        const simplified = {
            success: true,
            id: label.id,
            name: label.name
        };
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(simplified),
                },
            ],
        };
    }
    catch (error) {
        console.error("Error adding label:", error);
        throw new McpError(ErrorCode.InternalError, `Failed to add label: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export async function handleRemoveConfluenceLabel(client, args) {
    try {
        if (!args.pageId || !args.label) {
            throw new McpError(ErrorCode.InvalidParams, "pageId and label are required");
        }
        await client.removeConfluenceLabel(args.pageId, args.label);
        return {
            content: [
                {
                    type: "text",
                    text: `Successfully removed label '${args.label}' from page ${args.pageId}`,
                },
            ],
        };
    }
    catch (error) {
        console.error("Error removing label:", error);
        throw new McpError(ErrorCode.InternalError, `Failed to remove label: ${error instanceof Error ? error.message : String(error)}`);
    }
}

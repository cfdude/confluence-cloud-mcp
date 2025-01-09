#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { ConfluenceClient } from "./client/confluence-client.js";
import { handleGetConfluenceSpace, handleListConfluenceSpaces } from "./handlers/space-handlers.js";
import { handleCreateConfluencePage, handleGetConfluencePageById, handleGetConfluencePageByName, handleListConfluencePages, handleUpdateConfluencePage, } from "./handlers/page-handlers.js";
import { handleAddConfluenceLabel, handleGetConfluenceLabels, handleRemoveConfluenceLabel, handleSearchConfluenceContent, } from "./handlers/search-label-handlers.js";
import { toolSchemas } from "./schemas/tool-schemas.js";
// Required environment variables
const requiredEnvVars = [
    "CONFLUENCE_DOMAIN",
    "CONFLUENCE_EMAIL",
    "CONFLUENCE_API_TOKEN",
];
// Validate environment variables
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        throw new Error(`Missing required environment variable: ${envVar}`);
    }
}
class ConfluenceServer {
    server;
    confluenceClient;
    async initialize() {
        console.error("Loading tool schemas...");
        console.error("Available schemas:", Object.keys(toolSchemas));
        // Convert tool schemas to the format expected by the MCP SDK
        const tools = Object.entries(toolSchemas).map(([key, schema]) => {
            console.error(`Registering tool: ${key}`);
            const inputSchema = {
                type: "object",
                properties: schema.inputSchema.properties,
            };
            // Only add required field if it exists in the schema
            if ("required" in schema.inputSchema) {
                Object.assign(inputSchema, { required: schema.inputSchema.required });
            }
            return {
                name: key,
                description: schema.description,
                inputSchema,
            };
        });
        console.error("Initializing server with tools:", JSON.stringify(tools, null, 2));
        this.server = new Server({
            name: "confluence-cloud",
            version: "0.1.0",
        }, {
            capabilities: {
                tools: {
                    schemas: tools,
                },
                resources: {
                    schemas: [], // Explicitly define empty resources
                },
            },
        });
        this.confluenceClient = new ConfluenceClient({
            domain: process.env.CONFLUENCE_DOMAIN,
            email: process.env.CONFLUENCE_EMAIL,
            apiToken: process.env.CONFLUENCE_API_TOKEN,
        });
        // Verify connection to Confluence API
        await this.confluenceClient.verifyConnection();
        this.setupHandlers();
        this.server.onerror = (error) => console.error("[MCP Error]", error);
        process.on("SIGINT", async () => {
            await this.server.close();
            process.exit(0);
        });
    }
    constructor() {
        // Initialize asynchronously
        this.initialize().catch(error => {
            console.error("Failed to initialize server:", error);
            process.exit(1);
        });
    }
    setupHandlers() {
        // Set up required MCP protocol handlers
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: Object.entries(toolSchemas).map(([key, schema]) => ({
                name: key,
                description: schema.description,
                inputSchema: {
                    type: "object",
                    properties: schema.inputSchema.properties,
                    ...("required" in schema.inputSchema
                        ? { required: schema.inputSchema.required }
                        : {}),
                },
            })),
        }));
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
            resources: [], // No resources provided by this server
        }));
        this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
            resourceTemplates: [], // No resource templates provided by this server
        }));
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            throw new McpError(ErrorCode.InvalidRequest, `No resources available: ${request.params.uri}`);
        });
        // Set up tool handlers
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            console.error("Received request:", JSON.stringify(request, null, 2));
            const { name, arguments: args } = request.params;
            console.error(`Handling tool request: ${name}`);
            try {
                switch (name) {
                    // Space operations
                    case "list_confluence_spaces": {
                        const { limit, start } = (args || {});
                        return await handleListConfluenceSpaces(this.confluenceClient, { limit, start });
                    }
                    case "get_confluence_space": {
                        const { spaceId } = (args || {});
                        if (!spaceId)
                            throw new McpError(ErrorCode.InvalidParams, "spaceId is required");
                        return await handleGetConfluenceSpace(this.confluenceClient, { spaceId });
                    }
                    // Page operations
                    case "list_confluence_pages": {
                        const { spaceId, limit, start } = (args || {});
                        if (!spaceId)
                            throw new McpError(ErrorCode.InvalidParams, "spaceId is required");
                        return await handleListConfluencePages(this.confluenceClient, { spaceId, limit, start });
                    }
                    case "get_confluence_page_by_id": {
                        const { pageId } = (args || {});
                        if (!pageId)
                            throw new McpError(ErrorCode.InvalidParams, "pageId is required");
                        return await handleGetConfluencePageById(this.confluenceClient, { pageId });
                    }
                    case "get_confluence_page_by_name": {
                        const { title, spaceId } = (args || {});
                        if (!title)
                            throw new McpError(ErrorCode.InvalidParams, "title is required");
                        return await handleGetConfluencePageByName(this.confluenceClient, { title, spaceId });
                    }
                    case "create_confluence_page": {
                        const { spaceId, title, content, parentId } = (args || {});
                        if (!spaceId || !title || !content) {
                            throw new McpError(ErrorCode.InvalidParams, "spaceId, title, and content are required");
                        }
                        return await handleCreateConfluencePage(this.confluenceClient, { spaceId, title, content, parentId });
                    }
                    case "update_confluence_page": {
                        const { pageId, title, content, version } = (args || {});
                        if (!pageId || !title || !content || version === undefined) {
                            throw new McpError(ErrorCode.InvalidParams, "pageId, title, content, and version are required");
                        }
                        return await handleUpdateConfluencePage(this.confluenceClient, { pageId, title, content, version });
                    }
                    // Search operation
                    case "search_confluence_content": {
                        const { query, limit, start } = (args || {});
                        if (!query)
                            throw new McpError(ErrorCode.InvalidParams, "query is required");
                        return await handleSearchConfluenceContent(this.confluenceClient, { query, limit, start });
                    }
                    // Label operations
                    case "get_confluence_labels": {
                        const { pageId } = (args || {});
                        if (!pageId)
                            throw new McpError(ErrorCode.InvalidParams, "pageId is required");
                        return await handleGetConfluenceLabels(this.confluenceClient, { pageId });
                    }
                    case "add_confluence_label": {
                        const { pageId, label } = (args || {});
                        if (!pageId || !label)
                            throw new McpError(ErrorCode.InvalidParams, "pageId and label are required");
                        return await handleAddConfluenceLabel(this.confluenceClient, { pageId, label });
                    }
                    case "remove_confluence_label": {
                        const { pageId, label } = (args || {});
                        if (!pageId || !label)
                            throw new McpError(ErrorCode.InvalidParams, "pageId and label are required");
                        return await handleRemoveConfluenceLabel(this.confluenceClient, { pageId, label });
                    }
                    default:
                        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
                }
            }
            catch (error) {
                console.error("Error handling request:", error);
                if (error instanceof McpError) {
                    throw error;
                }
                throw new McpError(ErrorCode.InternalError, `Internal server error: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("Confluence Cloud MCP server running on stdio");
    }
}
const server = new ConfluenceServer();
server.run().catch(console.error);

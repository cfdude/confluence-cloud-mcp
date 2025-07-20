#!/usr/bin/env node
import dotenv from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ConfluenceClient } from "./client/confluence-client.js";
import {
  handleCreateConfluencePage,
  handleGetConfluencePage,
  handleFindConfluencePage,
  handleListConfluencePages,
  handleUpdateConfluencePage,
} from "./handlers/page-handlers.js";
import {
  handleAddConfluenceLabel,
  handleGetConfluenceLabels,
  handleRemoveConfluenceLabel,
  handleSearchConfluencePages,
} from "./handlers/search-label-handlers.js";
import { handleGetConfluenceSpace, handleListConfluenceSpaces } from "./handlers/space-handlers.js";
import { toolSchemas } from "./schemas/tool-schemas.js";

// Initialize authentication configuration
function initializeAuthConfig() {
  const domain = process.env.CONFLUENCE_DOMAIN;
  if (!domain) {
    throw new Error('Missing required environment variable: CONFLUENCE_DOMAIN');
  }

  // Check for OAuth2 configuration first
  const oauthAccessToken = process.env.CONFLUENCE_OAUTH_ACCESS_TOKEN;
  if (oauthAccessToken) {
    return {
      domain,
      auth: {
        type: 'oauth2' as const,
        accessToken: oauthAccessToken,
        refreshToken: process.env.CONFLUENCE_OAUTH_REFRESH_TOKEN,
        clientId: process.env.CONFLUENCE_OAUTH_CLIENT_ID,
        clientSecret: process.env.CONFLUENCE_OAUTH_CLIENT_SECRET
      }
    };
  }

  // Fall back to basic auth
  const email = process.env.CONFLUENCE_EMAIL;
  const apiToken = process.env.CONFLUENCE_API_TOKEN;
  
  if (!email || !apiToken) {
    throw new Error('Missing required environment variables: CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN');
  }

  return {
    domain,
    auth: {
      type: 'basic' as const,
      email,
      apiToken
    }
  };
}

class ConfluenceServer {
  private server!: Server;
  private confluenceClient!: ConfluenceClient;

  constructor() {
    // Initialize synchronously to ensure server is ready before handling requests
    this.initialize().catch(error => {
      console.error("Failed to initialize server:", error);
      process.exit(1);
    });
  }

  private async initialize() {
    console.error("Loading tool schemas...");
    console.error("Available schemas:", Object.keys(toolSchemas));

    // Convert tool schemas to the format expected by the MCP SDK
    const tools = Object.entries(toolSchemas).map(([key, schema]) => {
      console.error(`Registering tool: ${key}`);
      const inputSchema = {
        type: "object",
        properties: schema.inputSchema.properties,
        ...("required" in schema.inputSchema ? { required: schema.inputSchema.required } : {}),
      };
      return {
        name: key,
        description: schema.description,
        inputSchema,
      };
    });

    console.error("Initializing server with tools:", JSON.stringify(tools, null, 2));

    this.server = new Server(
      {
        name: "confluence-cloud",
        version: "1.10.1",
        protocolVersion: "2024-11-05",
        description: "Confluence Cloud MCP Server - Provides tools for interacting with any Confluence Cloud instance"
      },
      {
        capabilities: {
          tools: {
            schemas: tools,
          },
          resources: {
            schemas: [], // Explicitly define empty resources
          },
        },
      }
    );

    // Set up required MCP protocol handlers
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Object.entries(toolSchemas).map(([key, schema]) => ({
        name: key,
        description: schema.description,
        inputSchema: {
          type: "object",
          properties: schema.inputSchema.properties,
          ...(("required" in schema.inputSchema) ? { required: schema.inputSchema.required } : {}),
        },
      })),
    }));

    const config = initializeAuthConfig();
    
    console.error('Initializing Confluence client with config:', {
      domain: config.domain,
      authType: config.auth.type,
      // Mask sensitive data in logs
      ...(config.auth.type === 'basic'
        ? { email: config.auth.email }
        : { hasAccessToken: !!config.auth.accessToken })
    });

    this.confluenceClient = new ConfluenceClient(config);

    this.setupHandlers();

    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  // Wait for server to be ready
  async waitForReady(): Promise<void> {
    if (!this.server) {
      await new Promise<void>((resolve) => {
        const checkServer = () => {
          if (this.server) {
            resolve();
          } else {
            setTimeout(checkServer, 100);
          }
        };
        checkServer();
      });
    }
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [], // No resources provided by this server
    }));

    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: [], // No resource templates provided by this server
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `No resources available: ${request.params.uri}`
      );
    });

    // Set up tool handlers
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.error('Received request:', JSON.stringify(request, null, 2));
      
      const { name, arguments: args } = request.params;
      console.error(`Handling tool request: ${name}`);

      try {
        switch (name) {
          // Space operations
          case "list_confluence_spaces": {
            const { limit, cursor, sort } = (args || {}) as {
              limit?: number;
              cursor?: string;
              sort?: 'name' | '-name' | 'key' | '-key';
            };
            return await handleListConfluenceSpaces(this.confluenceClient, { limit, cursor, sort });
          }
          case "get_confluence_space": {
            const { spaceId } = (args || {}) as { spaceId: string };
            if (!spaceId) throw new McpError(ErrorCode.InvalidParams, "spaceId is required");
            return await handleGetConfluenceSpace(this.confluenceClient, { spaceId });
          }

          // Page operations
          case "list_confluence_pages": {
            const { spaceId, limit, cursor, sort, status } = (args || {}) as {
              spaceId: string;
              limit?: number;
              cursor?: string;
              sort?: 'created-date' | '-created-date' | 'modified-date' | '-modified-date' | 'title' | '-title';
              status?: 'current' | 'archived' | 'draft' | 'trashed';
            };
            if (!spaceId) throw new McpError(ErrorCode.InvalidParams, "spaceId is required");
            return await handleListConfluencePages(this.confluenceClient, { spaceId, limit, cursor, sort, status });
          }
          case "get_confluence_page": {
            const { pageId } = (args || {}) as { pageId: string };
            if (!pageId) throw new McpError(ErrorCode.InvalidParams, "pageId is required");
            return await handleGetConfluencePage(this.confluenceClient, { pageId });
          }
          case "find_confluence_page": {
            const { title, spaceId } = (args || {}) as { title: string; spaceId?: string };
            if (!title) throw new McpError(ErrorCode.InvalidParams, "title is required");
            return await handleFindConfluencePage(this.confluenceClient, { title, spaceId });
          }
          case "create_confluence_page": {
            const { spaceId, title, content, parentId } = (args || {}) as { 
              spaceId: string; 
              title: string; 
              content: string; 
              parentId?: string 
            };
            if (!spaceId || !title || !content) {
              throw new McpError(ErrorCode.InvalidParams, "spaceId, title, and content are required");
            }
            return await handleCreateConfluencePage(this.confluenceClient, { spaceId, title, content, parentId });
          }
          case "update_confluence_page": {
            const { pageId, title, content, version } = (args || {}) as {
              pageId: string;
              title: string;
              content: string;
              version: number;
            };
            if (!pageId || !title || !content || version === undefined) {
              throw new McpError(ErrorCode.InvalidParams, "pageId, title, content, and version are required");
            }
            return await handleUpdateConfluencePage(this.confluenceClient, { pageId, title, content, version });
          }

          // Search operation
          case "search_confluence_pages": {
            const { cql, limit, cursor } = (args || {}) as {
              cql: string;
              limit?: number;
              cursor?: string;
            };
            if (!cql) throw new McpError(ErrorCode.InvalidParams, "cql is required");
            return await handleSearchConfluencePages(this.confluenceClient, {
              cql,
              limit,
              cursor
            });
          }

          // Label operations
          case "get_confluence_labels": {
            const { pageId } = (args || {}) as { pageId: string };
            if (!pageId) throw new McpError(ErrorCode.InvalidParams, "pageId is required");
            return await handleGetConfluenceLabels(this.confluenceClient, { pageId });
          }
          case "add_confluence_label": {
            const { pageId, prefix, name } = (args || {}) as { pageId: string; prefix: string; name: string };
            if (!pageId || !prefix || !name) {
              throw new McpError(ErrorCode.InvalidParams, "pageId, prefix, and name are required");
            }
            if (prefix !== "global") {
              throw new McpError(ErrorCode.InvalidParams, "prefix must be 'global'");
            }
            return await handleAddConfluenceLabel(this.confluenceClient, { pageId, label: name, prefix });
          }
          case "remove_confluence_label": {
            const { pageId, label } = (args || {}) as { pageId: string; label: string };
            if (!pageId || !label) throw new McpError(ErrorCode.InvalidParams, "pageId and label are required");
            return await handleRemoveConfluenceLabel(this.confluenceClient, { pageId, label });
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        console.error("Error handling request:", error instanceof Error ? error.message : String(error));
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Internal server error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async run() {
    await this.waitForReady();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Confluence Cloud MCP server running on stdio");
  }
}

// Load environment variables before initializing
dotenv.config();

const server = new ConfluenceServer();
server.run().catch(console.error);
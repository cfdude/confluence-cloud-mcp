#!/usr/bin/env node
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
import dotenv from "dotenv";

import { handleListConfluenceInstances } from "./handlers/instance-handlers.js";
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

class ConfluenceServer {
  private server!: Server;

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
        description: "Confluence Cloud MCP Server - Provides tools for interacting with multiple Confluence Cloud instances"
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
          // Instance management
          case "list_confluence_instances":
            return await handleListConfluenceInstances();

          // Space operations
          case "list_confluence_spaces":
            return await handleListConfluenceSpaces(args as any || {});
          
          case "get_confluence_space":
            return await handleGetConfluenceSpace(args as any || {});

          // Page operations
          case "list_confluence_pages":
            return await handleListConfluencePages(args as any || {});
          
          case "get_confluence_page":
            return await handleGetConfluencePage(args as any || {});
          
          case "find_confluence_page":
            return await handleFindConfluencePage(args as any || {});
          
          case "create_confluence_page":
            return await handleCreateConfluencePage(args as any || {});
          
          case "update_confluence_page":
            return await handleUpdateConfluencePage(args as any || {});

          // Search operation
          case "search_confluence_pages":
            return await handleSearchConfluencePages(args as any || {});

          // Label operations
          case "get_confluence_labels":
            return await handleGetConfluenceLabels(args as any || {});
          
          case "add_confluence_label":
            return await handleAddConfluenceLabel(args as any || {});
          
          case "remove_confluence_label":
            return await handleRemoveConfluenceLabel(args as any || {});

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
    console.error("Multi-instance support enabled. Use 'list_confluence_instances' to see configured instances.");
  }
}

// Load environment variables before initializing
dotenv.config();

const server = new ConfluenceServer();
server.run().catch(console.error);
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { handleListConfluenceInstances } from './handlers/instance-handlers.js';
import {
  handleCreateConfluencePage,
  handleGetConfluencePage,
  handleFindConfluencePage,
  handleListConfluencePages,
  handleUpdateConfluencePage,
  handleMoveConfluencePage,
} from './handlers/page-handlers.js';
import {
  handleAddConfluenceLabel,
  handleGetConfluenceLabels,
  handleRemoveConfluenceLabel,
  handleSearchConfluencePages,
} from './handlers/search-label-handlers.js';
import { handleGetConfluenceSpace, handleListConfluenceSpaces } from './handlers/space-handlers.js';
import { toolSchemas } from './schemas/tool-schemas.js';

/**
 * Create and configure the MCP Server with all tool handlers registered.
 * Shared by both STDIO (index.ts) and HTTP (http-server.ts) entry points.
 */
export function createConfluenceServer(): Server {
  const server = new Server(
    {
      name: 'confluence-cloud',
      version: '1.11.0',
      description:
        'Confluence Cloud MCP Server - Provides tools for interacting with multiple Confluence Cloud instances',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(toolSchemas).map(([key, schema]) => ({
      name: key,
      description: schema.description,
      inputSchema: {
        type: 'object',
        properties: schema.inputSchema.properties,
        ...('required' in schema.inputSchema ? { required: schema.inputSchema.required } : {}),
      },
    })),
  }));

  // Resources handlers (none currently)
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    throw new McpError(ErrorCode.InvalidRequest, `No resources available: ${request.params.uri}`);
  });

  // Tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // Instance management
        case 'list_confluence_instances':
          return await handleListConfluenceInstances();

        // Space operations
        case 'list_confluence_spaces':
          return await handleListConfluenceSpaces((args as any) || {});

        case 'get_confluence_space':
          return await handleGetConfluenceSpace((args as any) || {});

        // Page operations
        case 'list_confluence_pages':
          return await handleListConfluencePages((args as any) || {});

        case 'get_confluence_page':
          return await handleGetConfluencePage((args as any) || {});

        case 'find_confluence_page':
          return await handleFindConfluencePage((args as any) || {});

        case 'create_confluence_page':
          return await handleCreateConfluencePage((args as any) || {});

        case 'update_confluence_page':
          return await handleUpdateConfluencePage((args as any) || {});

        case 'move_confluence_page':
          return await handleMoveConfluencePage((args as any) || {});

        // Search operation
        case 'search_confluence_pages':
          return await handleSearchConfluencePages((args as any) || {});

        // Label operations
        case 'get_confluence_labels':
          return await handleGetConfluenceLabels((args as any) || {});

        case 'add_confluence_label':
          return await handleAddConfluenceLabel((args as any) || {});

        case 'remove_confluence_label':
          return await handleRemoveConfluenceLabel((args as any) || {});

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        ErrorCode.InternalError,
        `Internal server error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  server.onerror = (error) => {
    console.error('[MCP Error]', error);
  };

  return server;
}

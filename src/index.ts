#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfiguration } from './config-loader.js';
import { getCrossServerConfig } from './config.js';
import {
  handleJiraHealthCheck,
  handleConfluenceHealthCheck,
  handleDiscoverJiraServers,
  handleLinkConfluenceToJira,
  handleCreateConfluenceFromJira,
  setServerDiscoveryManager,
} from './handlers/cross-server-handlers.js';
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
import { initializeHealthCheckManager } from './utils/health-check.js';
import { ServerDiscoveryManager } from './utils/server-discovery.js';

class ConfluenceServer {
  private server!: Server;
  private serverDiscoveryManager?: ServerDiscoveryManager;

  constructor() {
    // Initialize synchronously to ensure server is ready before handling requests
    this.initialize().catch((_error) => {
      // Failed to initialize server
      process.exit(1);
    });
  }

  private async initialize() {
    // Initialize health check manager with cross-server config
    await initializeHealthCheckManager();

    // Loading tool schemas
    // Available schemas loaded

    // Initializing server with tools

    this.server = new Server(
      {
        name: 'confluence-cloud',
        version: '1.10.1',
        description:
          'Confluence Cloud MCP Server - Provides tools for interacting with multiple Confluence Cloud instances',
      },
      {
        capabilities: {
          tools: {
          },
          resources: {
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
          type: 'object',
          properties: schema.inputSchema.properties,
          ...('required' in schema.inputSchema ? { required: schema.inputSchema.required } : {}),
        },
      })),
    }));

    // Initialize cross-server integration
    await this.initializeCrossServerIntegration();

    this.setupHandlers();

    this.server.onerror = (_error) => {
      /* MCP Error */
    };
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private async initializeCrossServerIntegration() {
    try {
      // Get cross-server configuration
      const crossServerConfig = await getCrossServerConfig();

      if (!crossServerConfig.enabled) {
        return;
      }

      // Create server discovery configuration
      const discoveryConfig = {
        enabled: true,
        jiraMcpEndpoint: 'http://localhost:3001/mcp',
        jiraMcpHealthEndpoint: 'http://localhost:3001/mcp/health',
        pollInterval: crossServerConfig.healthCheckInterval || 30000,
        connectionTimeout: 30000,
        maxRetries: 3,
        allowedOperations: crossServerConfig.allowedOperations || [],
        excludedOperations: crossServerConfig.excludedOperations || [],
        allowedModes: crossServerConfig.allowedModes || ['read', 'create'],
      };

      // Initialize server discovery manager
      this.serverDiscoveryManager = new ServerDiscoveryManager(discoveryConfig);

      // Set the discovery manager for cross-server handlers
      setServerDiscoveryManager(this.serverDiscoveryManager);

      // Start discovery process
      await this.serverDiscoveryManager.start();
    } catch (error) {
      // Cross-server integration initialization failed - continue without it
    }
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
      throw new McpError(ErrorCode.InvalidRequest, `No resources available: ${request.params.uri}`);
    });

    // Set up tool handlers
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Received request

      const { name, arguments: args } = request.params;
      // Handling tool request

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

          // Cross-server integration tools
          case 'jira_health_check':
            return await handleJiraHealthCheck((args as any) || {});

          case 'confluence_health_check':
            return await handleConfluenceHealthCheck();

          case 'discover_jira_servers':
            return await handleDiscoverJiraServers((args as any) || {});

          case 'link_confluence_to_jira':
            return await handleLinkConfluenceToJira((args as any) || {});

          case 'create_confluence_from_jira':
            return await handleCreateConfluenceFromJira((args as any) || {});

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        // Error handling request
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
    // Confluence Cloud MCP server running on stdio
  }
}

// Load configuration (supports OpenCode and traditional formats)
(async () => {
  await loadConfiguration();
  const server = new ConfluenceServer();
  server.run().catch((_error) => {
    // Server run failed - exit silently
  });
})();

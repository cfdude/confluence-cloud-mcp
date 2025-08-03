import { EventEmitter } from 'events';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface JiraServerInfo {
  serverType: string;
  version: string;
  status: 'ready' | 'starting' | 'error';
  crossServerIntegration?: {
    enabled: boolean;
    availableTools: string[];
    allowedIncomingOperations: string[];
    excludedOperations: string[];
  };
}

export interface JiraMcpClientConfig {
  httpEndpoint: string;
  healthEndpoint: string;
  timeout: number;
  maxRetries: number;
  allowedOperations: string[];
  excludedOperations: string[];
  allowedModes: string[];
  role: 'master' | 'slave';
}

export class CircuitBreaker {
  private failures = 0;
  private lastFailTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private errorThreshold = 5,
    private resetTimeout = 30000
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailTime > this.resetTimeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure() {
    this.failures++;
    this.lastFailTime = Date.now();

    if (this.failures >= this.errorThreshold) {
      this.state = 'open';
    }
  }

  getState() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailTime: this.lastFailTime,
    };
  }
}

export class JiraMcpClient extends EventEmitter {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connected = false;
  private serverInfo: JiraServerInfo | null = null;
  private circuitBreaker: CircuitBreaker;
  private availableTools = new Set<string>();

  constructor(private config: JiraMcpClientConfig) {
    super();
    this.circuitBreaker = new CircuitBreaker(5, 30000);
  }

  async initialize(): Promise<boolean> {
    try {
      // Create HTTP transport for native MCP communication
      this.transport = new StreamableHTTPClientTransport(new URL(this.config.httpEndpoint));

      // Create MCP client
      this.client = new Client(
        {
          name: 'confluence-to-jira-client',
          version: '1.0.0',
        },
        {
          capabilities: {},
        }
      );

      // Set up event handlers
      this.setupEventHandlers();

      // Connect to Jira MCP server via HTTP transport
      await this.client.connect(this.transport);

      this.connected = true;

      // Discover available tools via native MCP protocol
      await this.discoverTools();

      // Get server health information via native MCP health check tool
      await this.updateServerInfo();

      this.emit('connected', this.serverInfo);
      return true;
    } catch (error) {
      this.connected = false;
      this.emit('error', error);
      return false;
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.onerror = (error) => {
      this.emit('error', error);
      this.handleDisconnection();
    };

    // Handle transport disconnection
    if (this.transport) {
      this.transport.onclose = () => {
        this.handleDisconnection();
      };
    }
  }

  private async discoverTools(): Promise<void> {
    if (!this.client) return;

    try {
      const result = await this.client.listTools();
      this.availableTools.clear();

      result.tools.forEach((tool) => {
        this.availableTools.add(tool.name);
      });
    } catch (error) {
      // Tool discovery failed - continue with empty tool set
    }
  }

  private async updateServerInfo(): Promise<void> {
    try {
      // Try to get health information via native MCP health check tool
      const healthInfo = await this.callTool('jira_health_check', {});
      this.serverInfo = healthInfo as JiraServerInfo;
    } catch (error) {
      this.serverInfo = {
        serverType: 'jira-mcp',
        version: 'unknown',
        status: 'ready',
      };
    }
  }

  async callTool(toolName: string, args: any = {}): Promise<any> {
    if (!this.client || !this.connected) {
      throw new Error('Jira MCP client not connected');
    }

    // Check if operation is allowed
    if (!this.isOperationAllowed(toolName)) {
      throw new Error(`Operation ${toolName} not allowed by safety boundaries`);
    }

    // Check if tool is available
    if (!this.availableTools.has(toolName)) {
      throw new Error(`Tool ${toolName} not available on Jira MCP server`);
    }

    return await this.circuitBreaker.execute(async () => {
      const result = await this.client!.callTool({
        name: toolName,
        arguments: args,
      });

      return result;
    });
  }

  async performHealthCheck(): Promise<JiraServerInfo> {
    if (!this.connected) {
      throw new Error('Jira MCP client not connected');
    }

    try {
      // Call the native MCP health check tool
      const healthResult = await this.callTool('jira_health_check', {});
      return healthResult as JiraServerInfo;
    } catch (error) {
      throw new Error(
        `Jira health check failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private isOperationAllowed(toolName: string): boolean {
    // Check excluded operations
    if (this.config.excludedOperations.includes(toolName)) {
      return false;
    }

    // Check allowed operations (if specified)
    if (this.config.allowedOperations.length > 0) {
      return this.config.allowedOperations.includes(toolName);
    }

    // Check by operation mode
    const operationMode = this.getOperationMode(toolName);
    return this.config.allowedModes.includes(operationMode);
  }

  private getOperationMode(toolName: string): string {
    if (toolName.includes('delete') || toolName.includes('remove')) {
      return 'delete';
    }
    if (toolName.includes('update') || toolName.includes('edit') || toolName.includes('modify')) {
      return 'update';
    }
    if (toolName.includes('create') || toolName.includes('add')) {
      return 'create';
    }
    return 'read';
  }

  private handleDisconnection(): void {
    this.connected = false;
    this.emit('disconnected');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        // Client close failed - ignore as we're disconnecting anyway
      }
      this.client = null;
    }

    if (this.transport) {
      this.transport = null;
    }

    this.connected = false;
    this.emit('disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  getServerInfo(): JiraServerInfo | null {
    return this.serverInfo;
  }

  getAvailableTools(): string[] {
    return Array.from(this.availableTools);
  }

  getCircuitBreakerState() {
    return this.circuitBreaker.getState();
  }
}

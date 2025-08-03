import { EventEmitter } from 'events';

import { healthCheckManager, JiraServerConnection } from './health-check.js';
import { JiraMcpClient, JiraMcpClientConfig, JiraServerInfo } from '../clients/jira-mcp-client.js';

export interface ServerDiscoveryConfig {
  enabled: boolean;
  jiraMcpEndpoint?: string;
  jiraMcpHealthEndpoint?: string;
  pollInterval: number;
  connectionTimeout: number;
  maxRetries: number;
  allowedOperations: string[];
  excludedOperations: string[];
  allowedModes: string[];
}

export interface DiscoveredServer {
  httpEndpoint: string;
  healthEndpoint: string;
  serverType: string;
  version: string;
  client: JiraMcpClient | null;
  status: 'discovered' | 'connecting' | 'connected' | 'failed';
  lastAttempt: number;
  retryCount: number;
}

export interface HttpServerDiscoveryResult {
  httpEndpoint: string;
  healthEndpoint: string;
  serverType: string;
  version: string;
}

export class ServerDiscoveryManager extends EventEmitter {
  private isRunning = false;
  private discoveredServers = new Map<string, DiscoveredServer>();
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor(private config: ServerDiscoveryConfig) {
    super();
  }

  async start(): Promise<void> {
    if (this.isRunning || !this.config.enabled) {
      return;
    }

    this.isRunning = true;
    healthCheckManager.setStatus('starting');

    // Validate configuration
    const validation = await healthCheckManager.validateCrossServerConfiguration();
    if (!validation.valid) {
      this.emit('configError', validation.errors);
      return;
    }

    // Start initial discovery
    await this.performDiscovery();

    // Set up periodic polling
    this.pollTimer = setInterval(() => {
      this.performDiscovery();
    }, this.config.pollInterval);

    healthCheckManager.setStatus('ready');
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    // Clear polling timer
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Clear reconnect timers
    this.reconnectTimers.forEach((timer) => clearTimeout(timer));
    this.reconnectTimers.clear();

    // Disconnect all clients
    for (const server of this.discoveredServers.values()) {
      if (server.client) {
        await server.client.disconnect();
      }
    }

    this.discoveredServers.clear();
    this.emit('stopped');
  }

  private async performDiscovery(): Promise<void> {
    if (!this.config.jiraMcpEndpoint || !this.config.jiraMcpHealthEndpoint) {
      return;
    }

    try {
      // Try to connect to the HTTP endpoint
      const healthCheck = await this.performHttpHealthCheck(this.config.jiraMcpHealthEndpoint);

      if (healthCheck.available) {
        await this.handleServerFound({
          httpEndpoint: this.config.jiraMcpEndpoint,
          healthEndpoint: this.config.jiraMcpHealthEndpoint,
          serverType: healthCheck.serverType || 'jira-mcp',
          version: healthCheck.version || 'unknown',
        });
      } else {
        await this.handleServerLost(this.config.jiraMcpEndpoint);
      }
    } catch (error) {
      await this.handleServerLost(this.config.jiraMcpEndpoint);
      this.emit('discoveryError', error);
    }
  }

  private async performHttpHealthCheck(healthEndpoint: string): Promise<{
    available: boolean;
    serverType?: string;
    version?: string;
  }> {
    try {
      // Simple HTTP check to see if server is responding
      const response = await fetch(healthEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'jira_health_check',
          params: {},
          id: 1,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const result = await response.json();
        return {
          available: true,
          serverType: result?.result?.serverType || 'jira-mcp',
          version: result?.result?.version || 'unknown',
        };
      }
    } catch (error) {
      // Error checking server availability
    }

    return { available: false };
  }

  private async handleServerFound(result: HttpServerDiscoveryResult): Promise<void> {
    const serverEndpoint = result.httpEndpoint;
    let server = this.discoveredServers.get(serverEndpoint);

    if (!server) {
      // New server discovered
      server = {
        httpEndpoint: result.httpEndpoint,
        healthEndpoint: result.healthEndpoint,
        serverType: result.serverType || 'unknown',
        version: result.version || 'unknown',
        client: null,
        status: 'discovered',
        lastAttempt: 0,
        retryCount: 0,
      };

      this.discoveredServers.set(serverEndpoint, server);

      this.emit('serverDiscovered', server);
    }

    // Attempt connection if not already connected
    if (server.status !== 'connected' && server.status !== 'connecting') {
      await this.connectToServer(server);
    }
  }

  private async handleServerLost(serverEndpoint: string): Promise<void> {
    const server = this.discoveredServers.get(serverEndpoint);

    if (server && server.status === 'connected') {
      if (server.client) {
        await server.client.disconnect();
        server.client = null;
      }

      server.status = 'failed';
      healthCheckManager.removeConnectedServer(serverEndpoint);
      this.emit('serverLost', server);
    }
  }

  private async connectToServer(server: DiscoveredServer): Promise<void> {
    if (server.retryCount >= this.config.maxRetries) {
      return;
    }

    server.status = 'connecting';
    server.lastAttempt = Date.now();
    server.retryCount++;

    try {
      // Create client configuration for HTTP endpoints
      const clientConfig: JiraMcpClientConfig = {
        httpEndpoint: server.httpEndpoint,
        healthEndpoint: server.healthEndpoint,
        timeout: this.config.connectionTimeout,
        maxRetries: this.config.maxRetries,
        allowedOperations: this.config.allowedOperations,
        excludedOperations: this.config.excludedOperations,
        allowedModes: this.config.allowedModes,
        role: 'master',
      };

      // Create and initialize client
      const client = new JiraMcpClient(clientConfig);

      // Set up client event handlers
      this.setupClientEventHandlers(client, server);

      // Attempt connection via HTTP transport
      const connected = await client.initialize();

      if (connected) {
        server.client = client;
        server.status = 'connected';
        server.retryCount = 0;

        // Update health check manager
        const serverInfo = client.getServerInfo();
        if (serverInfo) {
          const connection: JiraServerConnection = {
            serverType: serverInfo.serverType,
            version: serverInfo.version,
            status: 'connected',
            lastSeen: Date.now(),
            capabilities: {
              tools: client.getAvailableTools(),
              supportedOperations:
                serverInfo.crossServerIntegration?.allowedIncomingOperations || [],
            },
          };

          healthCheckManager.addConnectedServer(server.httpEndpoint, connection);
        }

        this.emit('serverConnected', server);
      } else {
        throw new Error('Failed to initialize HTTP connection');
      }
    } catch (error) {
      server.status = 'failed';

      if (server.client) {
        await server.client.disconnect();
        server.client = null;
      }

      // Schedule retry with exponential backoff
      this.scheduleReconnect(server);
      this.emit('connectionFailed', server, error);
    }
  }

  private setupClientEventHandlers(client: JiraMcpClient, server: DiscoveredServer): void {
    client.on('connected', (_serverInfo: JiraServerInfo) => {
      // Server connected - handled by discovery logic
    });

    client.on('disconnected', () => {
      server.status = 'failed';
      healthCheckManager.updateServerConnection(server.httpEndpoint, {
        status: 'disconnected',
        lastSeen: Date.now(),
      });

      // Schedule reconnect
      this.scheduleReconnect(server);
    });

    client.on('error', (error: Error) => {
      this.emit('clientError', server, error);
    });
  }

  private scheduleReconnect(server: DiscoveredServer): void {
    // Clear existing timer
    const existingTimer = this.reconnectTimers.get(server.httpEndpoint);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Calculate delay with exponential backoff
    const baseDelay = 5000;
    const maxDelay = 60000;
    const delay = Math.min(baseDelay * Math.pow(2, server.retryCount - 1), maxDelay);

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(server.httpEndpoint);
      if (this.isRunning && server.status === 'failed') {
        this.connectToServer(server);
      }
    }, delay);

    this.reconnectTimers.set(server.httpEndpoint, timer);
  }

  // Public API methods

  getDiscoveredServers(): DiscoveredServer[] {
    return Array.from(this.discoveredServers.values());
  }

  getConnectedServers(): DiscoveredServer[] {
    return Array.from(this.discoveredServers.values()).filter(
      (server) => server.status === 'connected'
    );
  }

  getServerByEndpoint(endpoint: string): DiscoveredServer | undefined {
    return this.discoveredServers.get(endpoint);
  }

  async callJiraTool(toolName: string, args: any = {}, serverEndpoint?: string): Promise<any> {
    let targetServer: DiscoveredServer | undefined;

    if (serverEndpoint) {
      targetServer = this.discoveredServers.get(serverEndpoint);
    } else {
      // Use first connected server
      targetServer = Array.from(this.discoveredServers.values()).find(
        (server) => server.status === 'connected'
      );
    }

    if (!targetServer || !targetServer.client) {
      throw new Error('No connected Jira server available');
    }

    return await targetServer.client.callTool(toolName, args);
  }

  isAnyServerConnected(): boolean {
    return Array.from(this.discoveredServers.values()).some(
      (server) => server.status === 'connected'
    );
  }

  getServerConnectionStatus(): { [endpoint: string]: string } {
    const status: { [endpoint: string]: string } = {};
    this.discoveredServers.forEach((server, endpoint) => {
      status[endpoint] = server.status;
    });
    return status;
  }
}

// Create configuration from JSON config file
export async function createServerDiscoveryConfig(): Promise<ServerDiscoveryConfig> {
  const { getCrossServerConfig } = await import('../config.js');
  const crossServerConfig = await getCrossServerConfig();

  if (!crossServerConfig || !crossServerConfig.enabled) {
    return {
      enabled: false,
      pollInterval: 10000,
      connectionTimeout: 30000,
      maxRetries: 3,
      allowedOperations: [],
      excludedOperations: [],
      allowedModes: [],
    };
  }

  // Use the first enabled Jira server for now
  const primaryServer = crossServerConfig.jiraMcpServers.find((server) => server.enabled);

  return {
    enabled: crossServerConfig.enabled,
    jiraMcpEndpoint: primaryServer?.httpEndpoint,
    jiraMcpHealthEndpoint: primaryServer?.healthEndpoint,
    pollInterval: primaryServer?.pollInterval || 10000,
    connectionTimeout: primaryServer?.timeout || 30000,
    maxRetries: primaryServer?.maxRetries || 3,
    allowedOperations: primaryServer?.allowedOperations || [],
    excludedOperations: primaryServer?.excludedOperations || [],
    allowedModes: primaryServer?.allowedModes || ['read', 'create', 'update'],
  };
}

import { promises as fs } from 'fs';
import { join } from 'path';

export interface ConfluenceHealthInfo {
  serverType: string;
  version: string;
  status: 'ready' | 'starting' | 'error';
  timestamp: number;
  crossServerIntegration: {
    enabled: boolean;
    role: 'master' | 'slave';
    supportedJiraServers: string[];
    availableTools: string[];
    allowedIncomingOperations: string[];
    excludedOperations: string[];
    connectedJiraServers: JiraServerConnection[];
  };
  endpoints: {
    healthCheck: string;
    toolDiscovery: string;
  };
  configuration: {
    jiraMcpPath?: string;
    timeout: number;
    maxRetries: number;
    allowedModes: string[];
  };
}

export interface JiraServerConnection {
  serverType: string;
  version?: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  lastSeen: number;
  capabilities?: {
    tools: string[];
    supportedOperations: string[];
  };
}

export interface ServerDiscoveryResult {
  found: boolean;
  serverType?: string;
  version?: string;
  path?: string;
  error?: string;
}

export class HealthCheckManager {
  private status: 'ready' | 'starting' | 'error' = 'starting';
  private connectedServers = new Map<string, JiraServerConnection>();
  private startTime = Date.now();

  constructor(
    private serverVersion: string = '1.10.1',
    private crossServerEnabled: boolean = false
  ) {}

  setStatus(status: 'ready' | 'starting' | 'error') {
    this.status = status;
  }

  addConnectedServer(serverPath: string, connection: JiraServerConnection) {
    this.connectedServers.set(serverPath, connection);
  }

  removeConnectedServer(serverPath: string) {
    this.connectedServers.delete(serverPath);
  }

  updateServerConnection(serverPath: string, updates: Partial<JiraServerConnection>) {
    const existing = this.connectedServers.get(serverPath);
    if (existing) {
      this.connectedServers.set(serverPath, { ...existing, ...updates });
    }
  }

  getHealthInfo(): ConfluenceHealthInfo {
    const crossServerConfig = this.getCrossServerConfig();

    return {
      serverType: 'confluence-cloud-mcp',
      version: this.serverVersion,
      status: this.status,
      timestamp: Date.now(),
      crossServerIntegration: {
        enabled: this.crossServerEnabled,
        role: 'master',
        supportedJiraServers: ['mcp-jira-v1', 'generic-jira-mcp'],
        availableTools: this.getAvailableCrossServerTools(),
        allowedIncomingOperations: this.getAllowedIncomingOperations(),
        excludedOperations: this.getExcludedOperations(),
        connectedJiraServers: Array.from(this.connectedServers.values()),
      },
      endpoints: {
        healthCheck: '/health/confluence',
        toolDiscovery: '/tools/cross-server',
      },
      configuration: {
        jiraMcpPath: crossServerConfig.jiraMcpPath,
        timeout: crossServerConfig.timeout,
        maxRetries: crossServerConfig.maxRetries,
        allowedModes: crossServerConfig.allowedModes,
      },
    };
  }

  private getCrossServerConfig() {
    return {
      jiraMcpPath: process.env.JIRA_MCP_PATH,
      timeout: parseInt(process.env.JIRA_MCP_TIMEOUT || '30000'),
      maxRetries: parseInt(process.env.JIRA_MCP_MAX_RETRIES || '3'),
      allowedModes: (process.env.ALLOWED_OUTGOING_MODES || 'read,create,update').split(','),
    };
  }

  private getAvailableCrossServerTools(): string[] {
    return [
      'link_confluence_to_jira',
      'create_confluence_from_jira',
      'jira_health_check',
      'discover_jira_servers',
    ];
  }

  private getAllowedIncomingOperations(): string[] {
    const allowedModes = (process.env.ALLOWED_INCOMING_MODES || 'read,create').split(',');
    const operations: string[] = [];

    if (allowedModes.includes('read')) {
      operations.push('get_confluence_page', 'search_confluence_pages', 'get_confluence_space');
    }
    if (allowedModes.includes('create')) {
      operations.push('create_confluence_page');
    }
    if (allowedModes.includes('update')) {
      operations.push('update_confluence_page');
    }

    return operations;
  }

  private getExcludedOperations(): string[] {
    return (
      process.env.EXCLUDED_OPERATIONS || 'delete_confluence_page,delete_confluence_space'
    ).split(',');
  }

  async validateCrossServerConfiguration(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (!this.crossServerEnabled) {
      return { valid: true, errors: [] };
    }

    // Check if Jira MCP path is configured
    const jiraMcpPath = process.env.JIRA_MCP_PATH;
    if (!jiraMcpPath) {
      errors.push('JIRA_MCP_PATH environment variable not configured');
    } else {
      // Check if path exists
      try {
        await fs.access(jiraMcpPath);
      } catch (error) {
        errors.push(`Jira MCP server path does not exist: ${jiraMcpPath}`);
      }
    }

    // Validate timeout values
    const timeout = parseInt(process.env.JIRA_MCP_TIMEOUT || '30000');
    if (timeout < 5000 || timeout > 120000) {
      errors.push('JIRA_MCP_TIMEOUT should be between 5000 and 120000 milliseconds');
    }

    // Validate allowed modes
    const allowedModes = (process.env.ALLOWED_OUTGOING_MODES || '').split(',');
    const validModes = ['read', 'create', 'update', 'delete'];
    const invalidModes = allowedModes.filter((mode) => !validModes.includes(mode.trim()));
    if (invalidModes.length > 0) {
      errors.push(`Invalid modes in ALLOWED_OUTGOING_MODES: ${invalidModes.join(', ')}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  getUptime(): number {
    return Date.now() - this.startTime;
  }

  getConnectedServersInfo(): JiraServerConnection[] {
    return Array.from(this.connectedServers.values());
  }

  isJiraServerConnected(): boolean {
    return Array.from(this.connectedServers.values()).some(
      (server) => server.status === 'connected'
    );
  }
}

export async function discoverJiraServer(serverPath: string): Promise<ServerDiscoveryResult> {
  try {
    // Check if server file exists
    await fs.access(serverPath);

    // Try to determine server type from package.json or other indicators
    const serverDir = join(serverPath, '..');
    let serverType = 'generic-jira-mcp';
    let version = 'unknown';

    try {
      const packageJsonPath = join(serverDir, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

      if (packageJson.name === 'mcp-jira' || packageJson.name?.includes('jira')) {
        serverType = 'mcp-jira-v1';
        version = packageJson.version || 'unknown';
      }
    } catch (error) {
      // Package.json not found or not readable, use defaults
    }

    return {
      found: true,
      serverType,
      version,
      path: serverPath,
    };
  } catch (error) {
    return {
      found: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function pingJiraServer(serverPath: string, _timeout = 5000): Promise<boolean> {
  try {
    // In a real implementation, this might try to spawn the process briefly
    // or check if it's already running. For now, we just check file existence.
    await fs.access(serverPath);
    return true;
  } catch (error) {
    return false;
  }
}

export function createServerPollingFunction(
  serverPath: string,
  onServerFound: (serverInfo: ServerDiscoveryResult) => void,
  onServerLost: () => void,
  pollInterval = 5000
) {
  let isServerAvailable = false;
  let pollTimer: NodeJS.Timeout | null = null;

  const poll = async () => {
    try {
      const serverInfo = await discoverJiraServer(serverPath);

      if (serverInfo.found && !isServerAvailable) {
        // Server became available
        isServerAvailable = true;
        onServerFound(serverInfo);
      } else if (!serverInfo.found && isServerAvailable) {
        // Server became unavailable
        isServerAvailable = false;
        onServerLost();
      }
    } catch (error) {
      // Health check failed - continue monitoring
    }
  };

  const start = () => {
    if (pollTimer) return;

    // Initial poll
    poll();

    // Set up recurring polling
    pollTimer = setInterval(poll, pollInterval);
  };

  const stop = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  return { start, stop, poll };
}

// Global health check manager instance - will be initialized with config
export let healthCheckManager: HealthCheckManager;

// Initialize with configuration - to be called from index.ts
export async function initializeHealthCheckManager() {
  try {
    // Import getCrossServerConfig here to avoid circular dependencies
    const { getCrossServerConfig } = await import('../config.js');
    const crossServerConfig = await getCrossServerConfig();

    healthCheckManager = new HealthCheckManager('1.10.1', crossServerConfig.enabled);
    return healthCheckManager;
  } catch (error) {
    // Fallback to default if config loading fails
    healthCheckManager = new HealthCheckManager('1.10.1', false);
    return healthCheckManager;
  }
}

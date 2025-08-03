import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import type { ConfluenceConfig } from './types/index.js';

export interface InstanceConfig {
  email: string;
  apiToken: string;
  domain: string;
  spaces?: string[];
  // OAuth2 fields
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
}

interface SpaceConfig {
  instance: string;
  defaultParentPageId?: string;
  defaultLabels?: string[];
}

interface MultiInstanceConfig {
  instances: Record<string, InstanceConfig>;
  spaces?: Record<string, SpaceConfig>;
  defaultInstance?: string;
}

// Global config cache
let configCache: MultiInstanceConfig | null = null;
let configLoadTime = 0;
const CONFIG_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Load multi-instance configuration from .confluence-config.json
 */
export async function loadMultiInstanceConfig(): Promise<MultiInstanceConfig> {
  // Return cached config if still valid
  if (configCache && Date.now() - configLoadTime < CONFIG_TTL) {
    return configCache;
  }

  const configPath = join(homedir(), '.confluence-config.json');

  try {
    const configData = await readFile(configPath, 'utf-8');
    const config = JSON.parse(configData) as MultiInstanceConfig;

    // Validate configuration
    if (!config.instances || Object.keys(config.instances).length === 0) {
      throw new Error('No instances configured in .confluence-config.json');
    }

    // Validate each instance
    for (const [name, instance] of Object.entries(config.instances)) {
      if (!instance.email || !instance.apiToken || !instance.domain) {
        throw new Error(`Instance "${name}" missing required fields (email, apiToken, domain)`);
      }
    }

    // Cache the config
    configCache = config;
    configLoadTime = Date.now();

    return config;
  } catch (error) {
    // Fall back to environment variables for backward compatibility
    if ((error as any).code === 'ENOENT') {
      return createConfigFromEnv();
    }
    throw error;
  }
}

/**
 * Create configuration from environment variables (backward compatibility)
 */
function createConfigFromEnv(): MultiInstanceConfig {
  const domain = process.env.CONFLUENCE_DOMAIN;
  const email = process.env.CONFLUENCE_EMAIL;
  const apiToken = process.env.CONFLUENCE_API_TOKEN;
  const oauthAccessToken = process.env.CONFLUENCE_OAUTH_ACCESS_TOKEN;

  if (!domain) {
    throw new Error(
      'No configuration found. Create ~/.confluence-config.json or set CONFLUENCE_DOMAIN environment variable'
    );
  }

  // Create single instance config from env vars
  const config: MultiInstanceConfig = {
    instances: {
      default: {
        domain,
        email: email || '',
        apiToken: apiToken || '',
        oauthAccessToken,
        oauthRefreshToken: process.env.CONFLUENCE_OAUTH_REFRESH_TOKEN,
        oauthClientId: process.env.CONFLUENCE_OAUTH_CLIENT_ID,
        oauthClientSecret: process.env.CONFLUENCE_OAUTH_CLIENT_SECRET,
      },
    },
    defaultInstance: 'default',
  };

  // Validate OAuth or basic auth is present
  const instance = config.instances.default;
  if (!instance.oauthAccessToken && (!instance.email || !instance.apiToken)) {
    throw new Error(
      'Missing authentication credentials. Provide either OAuth token or email/apiToken'
    );
  }

  return config;
}

/**
 * Get instance configuration for a specific space
 */
export async function getInstanceForSpace(
  spaceKey: string | undefined,
  explicitInstance?: string
): Promise<{ instanceName: string; config: InstanceConfig }> {
  const config = await loadMultiInstanceConfig();

  // 1. Explicit instance override
  if (explicitInstance) {
    const instance = config.instances[explicitInstance];
    if (!instance) {
      throw new Error(`Instance "${explicitInstance}" not found in configuration`);
    }
    return { instanceName: explicitInstance, config: instance };
  }

  // 2. Space mapping
  if (spaceKey && config.spaces && config.spaces[spaceKey]) {
    const spaceConfig = config.spaces[spaceKey];
    const instance = config.instances[spaceConfig.instance];
    if (!instance) {
      throw new Error(
        `Instance "${spaceConfig.instance}" referenced by space "${spaceKey}" not found`
      );
    }
    return { instanceName: spaceConfig.instance, config: instance };
  }

  // 3. Auto-discovery from instance spaces
  if (spaceKey) {
    for (const [name, instance] of Object.entries(config.instances)) {
      if (instance.spaces && instance.spaces.includes(spaceKey)) {
        return { instanceName: name, config: instance };
      }
    }
  }

  // 4. Default instance
  if (config.defaultInstance) {
    const instance = config.instances[config.defaultInstance];
    if (!instance) {
      throw new Error(`Default instance "${config.defaultInstance}" not found`);
    }
    return { instanceName: config.defaultInstance, config: instance };
  }

  // 5. Single instance
  const instanceNames = Object.keys(config.instances);
  if (instanceNames.length === 1) {
    const name = instanceNames[0];
    return { instanceName: name, config: config.instances[name] };
  }

  // 6. Error - multiple instances, no selection criteria
  throw new Error(
    `Multiple Confluence instances configured. Please specify instance parameter or configure default instance. Available instances: ${instanceNames.join(', ')}`
  );
}

/**
 * Get space configuration if exists
 */
export async function getSpaceConfig(spaceKey: string): Promise<SpaceConfig | undefined> {
  const config = await loadMultiInstanceConfig();
  return config.spaces?.[spaceKey];
}

/**
 * List all available instances
 */
export async function listAvailableInstances(): Promise<
  Array<{
    name: string;
    domain: string;
    spaces?: string[];
    isDefault: boolean;
  }>
> {
  const config = await loadMultiInstanceConfig();

  return Object.entries(config.instances).map(([name, instance]) => ({
    name,
    domain: instance.domain,
    spaces: instance.spaces,
    isDefault: name === config.defaultInstance,
  }));
}

/**
 * Convert instance config to ConfluenceConfig format
 */
export function instanceToConfluenceConfig(instance: InstanceConfig): ConfluenceConfig {
  // OAuth2 authentication
  if (instance.oauthAccessToken) {
    return {
      domain: instance.domain,
      auth: {
        type: 'oauth2',
        accessToken: instance.oauthAccessToken,
        refreshToken: instance.oauthRefreshToken,
        clientId: instance.oauthClientId,
        clientSecret: instance.oauthClientSecret,
      },
    };
  }

  // Basic authentication
  return {
    domain: instance.domain,
    auth: {
      type: 'basic',
      email: instance.email,
      apiToken: instance.apiToken,
    },
  };
}

/**
 * Get cross-server integration configuration from environment variables
 */
export function getCrossServerConfig() {
  const config = {
    enabled: process.env.CROSS_SERVER_ENABLED === 'true',
    jiraServerUrl: process.env.JIRA_SERVER_URL,
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '30000', 10),
    allowedOperations: process.env.ALLOWED_OPERATIONS?.split(',') || [],
    excludedOperations: process.env.EXCLUDED_OPERATIONS?.split(',') || [],
    allowedModes: process.env.ALLOWED_MODES?.split(',') || ['read', 'create', 'update'],
    role: (process.env.SERVER_ROLE as 'master' | 'slave') || 'slave',
    jiraMcpServers: [] as Array<{
      enabled: boolean;
      httpEndpoint?: string;
      healthEndpoint?: string;
      pollInterval?: number;
      timeout?: number;
      maxRetries?: number;
      allowedOperations?: string[];
      excludedOperations?: string[];
      allowedModes?: string[];
    }>,
    safetyBoundaries: {
      allowedIncomingModes: (process.env.ALLOWED_INCOMING_MODES || 'read,create').split(','),
      allowedOutgoingModes: (process.env.ALLOWED_OUTGOING_MODES || 'read').split(','),
      excludedIncomingOperations: (process.env.EXCLUDED_INCOMING_OPERATIONS || '')
        .split(',')
        .filter(Boolean),
      excludedOutgoingOperations: (process.env.EXCLUDED_OUTGOING_OPERATIONS || '')
        .split(',')
        .filter(Boolean),
      maxBatchSize: parseInt(process.env.MAX_BATCH_SIZE || '10', 10),
      requireConfirmation: (process.env.REQUIRE_CONFIRMATION || '').split(',').filter(Boolean),
      rateLimits: {
        operationsPerMinute: parseInt(process.env.OPERATIONS_PER_MINUTE || '60', 10),
        operationsPerHour: parseInt(process.env.OPERATIONS_PER_HOUR || '1000', 10),
      },
    },
  };

  // Add Jira server configuration if URL is provided
  if (config.jiraServerUrl) {
    config.jiraMcpServers.push({
      enabled: true,
      httpEndpoint: config.jiraServerUrl,
      healthEndpoint: `${config.jiraServerUrl}/health`,
      pollInterval: config.healthCheckInterval,
      timeout: 30000,
      maxRetries: 3,
      allowedOperations: config.allowedOperations,
      excludedOperations: config.excludedOperations,
      allowedModes: config.allowedModes,
    });
  }

  return config;
}

/**
 * Clear config cache (useful for testing or config updates)
 */
export function clearConfigCache(): void {
  configCache = null;
  configLoadTime = 0;
}

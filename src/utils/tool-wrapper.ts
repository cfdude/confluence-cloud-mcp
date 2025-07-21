import { ConfluenceClient } from '../client/confluence-client.js';
import { getInstanceForSpace, getSpaceConfig, instanceToConfluenceConfig } from '../config.js';
import { getInstanceForPageId, cachePageInstance } from './instance-cache.js';
import type { ConfluenceConfig } from '../types/index.js';

interface ToolArgs {
  instance?: string;
  spaceId?: string;
  spaceKey?: string;
  pageId?: string;
  [key: string]: any;
}

interface ToolOptions {
  requiresSpace?: boolean;
  requiresPage?: boolean;
}

interface ToolContext {
  client: ConfluenceClient;
  instanceName: string;
  instanceConfig: ConfluenceConfig;
  spaceConfig?: any;
}

/**
 * Extract space key from various tool arguments
 */
function extractSpaceKey(args: ToolArgs): string | undefined {
  // Direct space key or ID
  if (args.spaceKey) return args.spaceKey;
  if (args.spaceId) return args.spaceId;
  
  // From search CQL
  if (args.cql) {
    const spaceMatch = args.cql.match(/space\s*=\s*["']([^"']+)["']/i);
    if (spaceMatch) return spaceMatch[1];
  }
  
  return undefined;
}

/**
 * Wrapper function for all Confluence tools to handle instance resolution
 */
export async function withConfluenceContext<T extends ToolArgs, R>(
  args: T,
  options: ToolOptions,
  handler: (args: T, context: ToolContext) => Promise<R>
): Promise<R> {
  try {
    let instanceName: string;
    let instanceConfig: ConfluenceConfig;
    
    // Extract space key from various sources
    const spaceKey = extractSpaceKey(args);
    
    // If we have a pageId but no space, try to get instance from cache
    if (args.pageId && !spaceKey && !args.instance) {
      const cachedInstance = await getInstanceForPageId(args.pageId);
      if (cachedInstance) {
        instanceName = cachedInstance.instanceName;
        instanceConfig = instanceToConfluenceConfig(cachedInstance.config);
      } else {
        // If page not in cache and no other context, we need to query each instance
        // This is handled by getInstanceForSpace with no space key
        const result = await getInstanceForSpace(undefined, args.instance);
        instanceName = result.instanceName;
        instanceConfig = instanceToConfluenceConfig(result.config);
      }
    } else {
      // Standard instance resolution
      const result = await getInstanceForSpace(spaceKey, args.instance);
      instanceName = result.instanceName;
      instanceConfig = instanceToConfluenceConfig(result.config);
    }
    
    // Create client for this instance
    const client = new ConfluenceClient(instanceConfig);
    
    // Get space config if available
    const spaceConfig = spaceKey ? await getSpaceConfig(spaceKey) : undefined;
    
    // Create context
    const context: ToolContext = {
      client,
      instanceName,
      instanceConfig,
      spaceConfig
    };
    
    // Execute the tool handler
    const result = await handler(args, context);
    
    // Cache page-to-instance mapping if we got a page result
    if ((result as any)?.content?.id && (result as any)?.content?.spaceId) {
      await cachePageInstance(
        (result as any).content.id,
        (result as any).content.spaceId,
        instanceName
      );
    }
    
    return result;
  } catch (error) {
    // Enhance error messages for instance-related issues
    if (error instanceof Error) {
      if (error.message.includes('Multiple Confluence instances configured')) {
        error.message += '\n\nUse the "list_confluence_instances" tool to see available instances.';
      }
    }
    throw error;
  }
}

/**
 * Tool arguments type helper
 */
export type { ToolArgs, ToolContext, ToolOptions };
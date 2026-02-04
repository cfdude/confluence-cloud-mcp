import { homedir } from 'os';
import { resolve } from 'path';

import dotenv from 'dotenv';

/**
 * Load configuration with support for OpenCode schema
 *
 * Priority order:
 * 1. CONFLUENCE_CONFIG_PATH environment variable (OpenCode or custom config)
 * 2. Inline environment variables (CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, CONFLUENCE_DOMAIN)
 * 3. Default location ~/.confluence-config.json
 * 4. .env file in project root (backward compatibility)
 */
export async function loadConfiguration(): Promise<void> {
  // Load .env file for backward compatibility
  dotenv.config();

  // If CONFLUENCE_CONFIG_PATH is set (from OpenCode or env), prepare it for use
  if (process.env.CONFLUENCE_CONFIG_PATH) {
    // Resolve ~ to home directory if present
    const configPath = process.env.CONFLUENCE_CONFIG_PATH.replace(/^~/, homedir());

    // Set the resolved path for the config loader to use
    // This allows loadMultiInstanceConfig() in config.ts to find the custom config file
    process.env.CONFLUENCE_CONFIG_FILE = resolve(configPath);

    // Log for debugging (only in debug mode)
    if (process.env.DEBUG === 'true') {
      console.error(
        `[config-loader] Using config file from CONFLUENCE_CONFIG_PATH: ${process.env.CONFLUENCE_CONFIG_FILE}`
      );
    }
  }

  // The actual configuration loading will be handled by the existing
  // loadMultiInstanceConfig() function in config.ts, which will now check
  // for CONFLUENCE_CONFIG_FILE environment variable first
}

/**
 * Check if inline environment variables are present
 * This helps determine if we're using simple inline config vs file-based config
 */
export function hasInlineEnvVars(): boolean {
  return !!(
    process.env.CONFLUENCE_DOMAIN &&
    // Either OAuth token
    (process.env.CONFLUENCE_OAUTH_ACCESS_TOKEN ||
      // Or basic auth (email + API token)
      (process.env.CONFLUENCE_EMAIL && process.env.CONFLUENCE_API_TOKEN))
  );
}

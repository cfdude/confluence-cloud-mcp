#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfiguration } from './config-loader.js';
import { createConfluenceServer } from './server.js';

async function main() {
  await loadConfiguration();

  const server = createConfluenceServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Confluence Cloud MCP server running on stdio');

  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

# Confluence Cloud MCP Server Development Guide

This document provides information about development and troubleshooting for the Confluence Cloud MCP server.

## Troubleshooting

### API Verification

The server performs API verification during initialization to ensure that the Confluence API credentials are valid and the API is reachable. If the verification fails, the server will exit with an error message, preventing it from starting with invalid credentials.

This approach has several advantages:

1. Users get immediate feedback if their API credentials are invalid
2. The server won't start with invalid credentials, avoiding confusion when tools don't work
3. Detailed error messages help users troubleshoot connection issues

The verification is implemented in the `verifyApiConnection` method in the `ConfluenceClient` class:

```typescript
async verifyApiConnection(): Promise<void> {
  try {
    // Make a simple API call that should work with minimal permissions
    await this.v2Client.get('/spaces', { params: { limit: 1 } });
    console.error('Successfully connected to Confluence API');
  } catch (error) {
    let errorMessage = 'Failed to connect to Confluence API';
    
    if (axios.isAxiosError(error)) {
      // Provide specific error messages based on status code
      if (error.response && error.response.status === 401) {
        errorMessage = 'Authentication failed: Invalid API token or email';
      } else if (error.response && error.response.status === 403) {
        errorMessage = 'Authorization failed: Insufficient permissions';
      } else if (error.response && error.response.status === 404) {
        errorMessage = 'API endpoint not found: Check Confluence domain';
      } else if (error.response && error.response.status >= 500) {
        errorMessage = 'Confluence server error: API may be temporarily unavailable';
      }
      
      console.error(`${errorMessage}:`, errorDetails);
    } else {
      console.error(errorMessage + ':', error instanceof Error ? error.message : String(error));
    }
    
    // Throw error with detailed message to fail server initialization
    throw new Error(errorMessage);
  }
}
```

The server initialization in the `ConfluenceServer` class calls this method:

```typescript
// Verify API connection - will throw an error if verification fails
await this.confluenceClient.verifyApiConnection();
```

If the verification fails, the error is caught in the constructor's catch block, which logs the error and exits the process:

```typescript
constructor() {
  // Initialize asynchronously
  this.initialize().catch(error => {
    console.error("Failed to initialize server:", error);
    process.exit(1);
  });
}
```

This approach ensures that the server only starts if the API credentials are valid, providing a better user experience.

## Local Development

### Building and Running Locally

1. Build the project:
```bash
npm run build
```

2. Run the server with test credentials:
```bash
CONFLUENCE_API_TOKEN=your_token CONFLUENCE_EMAIL=your_email CONFLUENCE_DOMAIN=your_domain node build/index.js
```

### Building and Running with Docker

1. Build the Docker image:
```bash
./scripts/build-local.sh
```

2. Run the Docker image:
```bash
CONFLUENCE_API_TOKEN=your_token CONFLUENCE_EMAIL=your_email CONFLUENCE_DOMAIN=your_domain ./scripts/run-local.sh
```

### Using the MCP Inspector

The MCP Inspector is a tool that helps diagnose issues with MCP servers:

1. Run the inspector:
```bash
npm run inspector
```

2. Open http://localhost:5173 in your browser
3. Configure the inspector to connect to your server
4. Use the inspector to test the server's capabilities

## Updating the MCP SDK

The server uses the MCP SDK to communicate with the MCP system. If you encounter compatibility issues, you may need to update the SDK:

```bash
npm install @modelcontextprotocol/sdk@latest
```

After updating the SDK, rebuild the project and the Docker image.

## Configuring Claude Desktop

To use the local Docker image with Claude Desktop:

1. Update the Claude desktop config file:
```json
{
  "mcpServers": {
    "confluence": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "confluence-cloud-mcp:local"],
      "env": {
        "CONFLUENCE_DOMAIN": "your-domain.atlassian.net",
        "CONFLUENCE_EMAIL": "your-email@domain.com",
        "CONFLUENCE_API_TOKEN": "your-api-token"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

2. Restart the Claude desktop app for the changes to take effect

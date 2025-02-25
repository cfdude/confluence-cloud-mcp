# Confluence Cloud MCP Server Installation Guide for AI Assistants

This guide provides detailed instructions for AI assistants like Cline to install and configure the Confluence Cloud MCP server. Following these steps will enable seamless integration with Atlassian Confluence Cloud.

## Prerequisites

- Docker installed on the host system
- Atlassian Confluence Cloud account with API access
- Confluence API token (generated from Atlassian account)
- Node.js v20+ (only if installing from source)

## Installation Options

### Option 1: Using Pre-built Docker Image (Recommended)

```json
{
  "mcpServers": {
    "confluence": {
      "command": "docker",
      "args": ["run", "--rm", "-i", 
        "ghcr.io/aaronsb/confluence-cloud-mcp:latest"],
      "env": {
        "CONFLUENCE_HOST": "your-domain.atlassian.net",
        "CONFLUENCE_EMAIL": "your-email@domain.com",
        "CONFLUENCE_API_TOKEN": "your-api-token"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Option 2: Building and Running Locally

1. Clone the repository:
```bash
git clone https://github.com/aaronsb/confluence-cloud-mcp.git
cd confluence-cloud-mcp
```

2. Build the Docker image:
```bash
./scripts/build-local.sh
```

3. Add to MCP configuration:
```json
{
  "mcpServers": {
    "confluence": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "confluence-cloud-mcp:local"],
      "env": {
        "CONFLUENCE_HOST": "your-domain.atlassian.net",
        "CONFLUENCE_EMAIL": "your-email@domain.com",
        "CONFLUENCE_API_TOKEN": "your-api-token"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Option 3: Running from Source

1. Clone the repository:
```bash
git clone https://github.com/aaronsb/confluence-cloud-mcp.git
cd confluence-cloud-mcp
```

2. Install dependencies and build:
```bash
npm install
npm run build
```

3. Add to MCP configuration:
```json
{
  "mcpServers": {
    "confluence": {
      "command": "node",
      "args": ["/path/to/confluence-cloud-mcp/build/index.js"],
      "env": {
        "CONFLUENCE_HOST": "your-domain.atlassian.net",
        "CONFLUENCE_EMAIL": "your-email@domain.com",
        "CONFLUENCE_API_TOKEN": "your-api-token"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Obtaining Confluence API Credentials

1. Log in to your Atlassian account at https://id.atlassian.com/manage-profile/security/api-tokens
2. Click "Create API token"
3. Enter a label for your token (e.g., "MCP Server")
4. Click "Create" and copy the generated token
5. Use this token as the `CONFLUENCE_API_TOKEN` value
6. Use your Atlassian account email as the `CONFLUENCE_EMAIL` value
7. Use your Confluence Cloud instance URL (e.g., "your-domain.atlassian.net") as the `CONFLUENCE_HOST` value

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| CONFLUENCE_API_TOKEN | Yes | Your Atlassian API token |
| CONFLUENCE_EMAIL | Yes | Your Atlassian account email |
| CONFLUENCE_HOST | No | Your Confluence Cloud domain (defaults to "your-domain.atlassian.net") |
| MCP_MODE | No | Set to "true" by default in Docker container |
| LOG_FILE | No | Path to log file (defaults to "/app/logs/confluence-cloud-mcp.log" in Docker) |

## Troubleshooting

### Connection Issues

If you encounter connection issues:

1. Verify your API token is valid and not expired
2. Ensure your email address matches the one associated with the API token
3. Check that your Confluence host URL is correct
4. Confirm network connectivity to Atlassian's servers

### Permission Issues

If you encounter permission errors:

1. Verify your Atlassian account has appropriate permissions in Confluence
2. Check that your API token has not been revoked
3. Ensure you're not hitting API rate limits

### Docker Issues

If you encounter Docker-related issues:

1. Ensure Docker is running on your system
2. Verify you have permission to run Docker containers
3. Check if the Docker image exists locally or can be pulled from the registry

## Available Tools

Once installed, the following tools will be available:

### Space Tools
- `list_spaces`: List all spaces in Confluence
- `get_space`: Get details about a specific space

### Page Tools
- `list_pages`: List pages in a space
- `get_page`: Get a specific page with its content (includes Markdown conversion)
- `create_page`: Create a new page in a space
- `update_page`: Update an existing page

### Search & Label Tools
- `search_content`: Search Confluence content using CQL
- `get_labels`: Get labels for a page
- `add_label`: Add a label to a page
- `remove_label`: Remove a label from a page

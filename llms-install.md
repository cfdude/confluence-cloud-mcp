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
        "ghcr.io/cfdude/confluence-cloud-mcp:latest"],
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

### Option 2: Building and Running Locally

1. Clone the repository:
```bash
git clone https://github.com/cfdude/confluence-cloud-mcp.git
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

### Option 3: Running from Source

1. Clone the repository:
```bash
git clone https://github.com/cfdude/confluence-cloud-mcp.git
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

## Obtaining Confluence API Credentials

1. Log in to your Atlassian account at https://id.atlassian.com/manage-profile/security/api-tokens
2. Click "Create API token"
3. Enter a label for your token (e.g., "MCP Server")
4. Click "Create" and copy the generated token
5. Use this token as the `CONFLUENCE_API_TOKEN` value
6. Use your Atlassian account email as the `CONFLUENCE_EMAIL` value
7. Use your Confluence Cloud instance URL (e.g., "your-domain.atlassian.net") as the `CONFLUENCE_DOMAIN` value

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| CONFLUENCE_API_TOKEN | Yes | Your Atlassian API token |
| CONFLUENCE_EMAIL | Yes | Your Atlassian account email |
| CONFLUENCE_DOMAIN | No | Your Confluence Cloud domain (defaults to "your-domain.atlassian.net") |
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

### Instance Tools
- `list_confluence_instances`: List the configured Confluence instances

### Space Tools
- `list_confluence_spaces`: List all spaces in Confluence
- `get_confluence_space`: Get details about a specific space

### Page Tools
- `list_confluence_pages`: List pages in a space
- `get_confluence_page`: Read a page. Returns `content` (markdown, for READING), `storage`
  (the raw XHTML a write must be authored against), `version`, a `lossy` flag, and a heading
  `outline`
- `find_confluence_page`: Find a page by title
- `create_confluence_page`: Create a new page in a space
- `update_confluence_page`: Replace a whole page's content (title optional and preserved when
  omitted; the server resolves the version)
- `move_confluence_page`: Move a page to a new parent or space

### Section Tools
- `replace_confluence_section`: Replace the body of one section, identified by its heading
- `append_confluence_section`: Append content to the end of one section
- `insert_confluence_section`: Insert a new section after an existing one

Prefer these over `update_confluence_page` for a partial edit: they splice one section by byte
offsets, so macros and layouts outside it are preserved exactly.

### Validation Tools
- `validate_confluence_content`: Check content against every write-safety rule before
  submitting it, reporting all problems at once. Never writes.

### Search & Label Tools
- `search_confluence_pages`: Search Confluence content using CQL
- `get_confluence_labels`: Get labels for a page
- `add_confluence_label`: Add a label to a page
- `remove_confluence_label`: Remove a label from a page

> **Note**: All tool names follow the [verb]_confluence_[noun] naming convention for consistency and clarity.

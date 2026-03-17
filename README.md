# Confluence Cloud MCP Server

A Model Context Protocol (MCP) server that provides tools for interacting with Confluence Cloud. This server enables AI assistants to manage Confluence spaces, pages, and content through a standardized interface.

**Now with multi-instance support!** Work with multiple Confluence instances seamlessly. See [CONFIGURATION.md](CONFIGURATION.md) for details.

[![CI/CD Pipeline](https://github.com/aaronsb/confluence-cloud-mcp/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/aaronsb/confluence-cloud-mcp/actions/workflows/ci-cd.yml)

## Features

- **Multi-Instance Support**
  - Work with multiple Confluence instances
  - Automatic instance routing based on space context
  - Per-instance authentication
- **Dual Transport**
  - STDIO for Claude Desktop (spawns its own process)
  - HTTP via StreamableHTTP for Claude Code / PM2 (shared single instance)
- Space Management
  - List spaces
  - Get space details
- Page Operations
  - Create, read, update, move pages
  - Find pages by title
  - List pages in a space
  - Convert page content from Confluence storage format to Markdown
- Search & Labels
  - Search content using CQL
  - Manage page labels

## Setup

### OpenCode Configuration

This server supports [OpenCode](https://opencode.ai) configuration format. See [OPENCODE.md](OPENCODE.md) for detailed setup instructions.

**Quick example for OpenCode:**
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "confluence-cloud": {
      "type": "local",
      "command": ["npx", "confluence-cloud-mcp"],
      "enabled": true,
      "environment": {
        "CONFLUENCE_CONFIG_PATH": "~/.confluence-config.json"
      }
    }
  }
}
```

### Option 1: Using Docker (Recommended)

The easiest way to use this server is with the pre-built Docker image:

```bash
docker run --rm -i \
  -e CONFLUENCE_API_TOKEN=your-api-token \
  -e CONFLUENCE_EMAIL=your-email@domain.com \
  -e CONFLUENCE_DOMAIN=your-domain.atlassian.net \
  ghcr.io/aaronsb/confluence-cloud-mcp:latest
```

### Option 2: Building Locally

1. Clone the repository:
```bash
git clone https://github.com/aaronsb/confluence-cloud-mcp.git
cd confluence-cloud-mcp
```

2. Build and run using the local build script:
```bash
# Build the Docker image
./scripts/build-local.sh

# Run the server
CONFLUENCE_API_TOKEN=your-token CONFLUENCE_EMAIL=your-email ./scripts/run-local.sh
```

### Option 3: From Source

1. Install dependencies:
```bash
npm install
```

2. Configure your instance(s):

**For multiple instances**, create `~/.confluence-config.json`:
```json
{
  "instances": {
    "prod": {
      "domain": "company.atlassian.net",
      "email": "user@company.com",
      "apiToken": "your-api-token"
    },
    "dev": {
      "domain": "company-dev.atlassian.net",
      "email": "user@company.com",
      "apiToken": "your-api-token"
    }
  },
  "defaultInstance": "prod"
}
```

**For a single instance**, create a `.env` file:
```
CONFLUENCE_DOMAIN=your-domain.atlassian.net
CONFLUENCE_EMAIL=your-email@domain.com
CONFLUENCE_API_TOKEN=your-api-token
```

3. Build the project:
```bash
npm run build
```

4. Run the server:

**STDIO mode** (for Claude Desktop):
```bash
node build/index.js
```

**HTTP mode** (for Claude Code / shared access via PM2):
```bash
node build/http-server.js --port=8106
# Or via npm:
npm run start:http
```

### Option 4: PM2 Deployment (HTTP Transport)

For shared access across multiple Claude Code projects:

```bash
# Copy and configure the ecosystem template
cp ecosystem.config.cjs.example ecosystem.config.cjs
# Edit ecosystem.config.cjs with your local paths

# Start via PM2
pm2 start ecosystem.config.cjs
pm2 save

# Add to Claude Code (user scope)
claude mcp add --scope user confluence-cloud-mcp --transport http --url http://localhost:8106/mcp
```

## Usage

The server can be integrated with MCP-compatible AI assistants by adding it to their MCP configuration:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "ghcr.io/aaronsb/confluence-cloud-mcp:latest"],
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

> **Note for AI Assistants**: If you're an AI assistant like Cline trying to install this MCP server, please refer to the [llms-install.md](llms-install.md) file for detailed installation instructions.

## Available Tools (13)

### Instance Management
- `list_confluence_instances`: List all configured Confluence instances

### Space Tools
- `list_confluence_spaces`: List all spaces in Confluence
- `get_confluence_space`: Get details about a specific space

### Page Tools
- `list_confluence_pages`: List pages in a space
- `get_confluence_page`: Get a specific page with its content (includes Markdown conversion)
- `find_confluence_page`: Find a page by title across spaces
- `create_confluence_page`: Create a new page in a space
- `update_confluence_page`: Update an existing page
- `move_confluence_page`: Move a page to a new parent or space

The `get_confluence_page` tool automatically converts Confluence storage format content to Markdown, making it easier to work with page content. The conversion handles:
- Headers (h1-h6)
- Lists (ordered and unordered)
- Links
- Emphasis (bold/italic)
- Code blocks
- Tables
- Paragraphs and line breaks

### Search & Label Tools
- `search_confluence_pages`: Search Confluence content using CQL
- `get_confluence_labels`: Get labels for a page
- `add_confluence_label`: Add a label to a page
- `remove_confluence_label`: Remove a label from a page

> **Note**: All tool names follow the [verb]_confluence_[noun] naming convention for consistency and clarity.

## Development

This project is written in TypeScript and follows the MCP SDK conventions for implementing server capabilities. The codebase is organized into:

- `src/server.ts` - Shared MCP server factory (used by both STDIO and HTTP entry points)
- `src/index.ts` - STDIO entry point (for Claude Desktop)
- `src/http-server.ts` - HTTP entry point with StreamableHTTP transport (for PM2/Claude Code)
- `src/config.ts` - Multi-instance configuration loader
- `src/config-loader.ts` - Environment/OpenCode configuration support
- `src/client/` - Confluence API client implementation
- `src/handlers/` - MCP tool request handlers (pages, spaces, search/labels, instances)
- `src/schemas/` - JSON schemas for tool inputs
- `src/types/` - TypeScript type definitions
- `src/utils/` - Utility functions (content conversion, instance caching, API helpers, tool wrapper)

### CI/CD Pipeline

This project uses GitHub Actions for continuous integration and deployment:

- Automated testing and linting on pull requests
- Automatic Docker image builds on main branch commits
- Multi-architecture image builds (amd64, arm64)
- Container publishing to GitHub Container Registry

### Local Development

For local development, use the provided scripts:

- `./scripts/build-local.sh`: Builds the project and creates a local Docker image
- `./scripts/run-local.sh`: Runs the local Docker image with your credentials

## License

MIT

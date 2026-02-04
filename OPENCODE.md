# OpenCode Configuration Guide

This guide explains how to configure the Confluence Cloud MCP server for use with [OpenCode](https://opencode.ai).

## Table of Contents
- [Quick Start](#quick-start)
- [Configuration Options](#configuration-options)
- [Advanced Setup](#advanced-setup)
- [Migration Guide](#migration-guide)

## Quick Start

### Option 1: Using Existing Configuration

If you already have `~/.confluence-config.json` set up, add this to your `opencode.json`:

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

### Option 2: Simple Inline Configuration

For basic single-instance usage without a config file:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "confluence-cloud": {
      "type": "local",
      "command": ["npx", "confluence-cloud-mcp"],
      "enabled": true,
      "environment": {
        "CONFLUENCE_EMAIL": "user@example.com",
        "CONFLUENCE_API_TOKEN": "your-api-token",
        "CONFLUENCE_DOMAIN": "company.atlassian.net"
      }
    }
  }
}
```

### Option 3: Custom Configuration Location

To use a different config file location:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "confluence-cloud": {
      "type": "local",
      "command": ["npx", "confluence-cloud-mcp"],
      "enabled": true,
      "environment": {
        "CONFLUENCE_CONFIG_PATH": "/custom/path/to/confluence-config.json"
      }
    }
  }
}
```

## Configuration Options

### Environment Variables

The following environment variables can be used in the OpenCode configuration:

| Variable | Description | Example |
|----------|-------------|---------|
| `CONFLUENCE_CONFIG_PATH` | Path to configuration file | `~/.confluence-config.json` |
| `CONFLUENCE_EMAIL` | Atlassian account email | `user@example.com` |
| `CONFLUENCE_API_TOKEN` | Atlassian API token | `ATATT3xFfG...` |
| `CONFLUENCE_DOMAIN` | Confluence Cloud domain | `company.atlassian.net` |
| `CONFLUENCE_OAUTH_ACCESS_TOKEN` | OAuth2 access token (optional) | `oauth_token_here` |

### Configuration File Structure

When using `CONFLUENCE_CONFIG_PATH`, the referenced JSON file should follow this structure:

```json
{
  "instances": {
    "prod": {
      "email": "user@example.com",
      "apiToken": "your-api-token",
      "domain": "prod.atlassian.net",
      "spaces": ["PROD", "DOCS"]
    },
    "dev": {
      "email": "user@example.com",
      "apiToken": "dev-api-token",
      "domain": "dev.atlassian.net",
      "spaces": ["DEV", "TEST"]
    }
  },
  "spaces": {
    "PROD": {
      "instance": "prod",
      "defaultParentPageId": "12345"
    }
  },
  "defaultInstance": "prod"
}
```

## Advanced Setup

### Multiple Instances with Different Configs

You can run multiple Confluence instances with different configurations:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "confluence-prod": {
      "type": "local",
      "command": ["npx", "confluence-cloud-mcp"],
      "enabled": true,
      "environment": {
        "CONFLUENCE_CONFIG_PATH": "~/prod-confluence-config.json"
      }
    },
    "confluence-dev": {
      "type": "local",
      "command": ["npx", "confluence-cloud-mcp"],
      "enabled": true,
      "environment": {
        "CONFLUENCE_CONFIG_PATH": "~/dev-confluence-config.json"
      }
    }
  }
}
```

### Using with Docker

For Docker deployments:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "confluence-cloud": {
      "type": "local",
      "command": [
        "docker", "run", "--rm", "-i",
        "-v", "${HOME}/.confluence-config.json:/app/.confluence-config.json:ro",
        "ghcr.io/aaronsb/confluence-cloud-mcp:latest"
      ],
      "enabled": true,
      "environment": {
        "CONFLUENCE_CONFIG_PATH": "/app/.confluence-config.json"
      }
    }
  }
}
```

### Using with Local Build

If you've built the server locally:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "confluence-cloud": {
      "type": "local",
      "command": ["node", "/path/to/confluence-cloud-mcp/build/index.js"],
      "enabled": true,
      "environment": {
        "CONFLUENCE_CONFIG_PATH": "~/.confluence-config.json"
      }
    }
  }
}
```

## Migration Guide

### From Traditional MCP Configuration

If you're migrating from a traditional MCP configuration:

**Before (Traditional MCP):**
```json
{
  "mcpServers": {
    "confluence": {
      "command": "node",
      "args": ["/path/to/confluence-cloud-mcp/build/index.js"],
      "env": {
        "CONFLUENCE_DOMAIN": "company.atlassian.net",
        "CONFLUENCE_EMAIL": "user@example.com",
        "CONFLUENCE_API_TOKEN": "token"
      }
    }
  }
}
```

**After (OpenCode):**
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "confluence-cloud": {
      "type": "local",
      "command": ["node", "/path/to/confluence-cloud-mcp/build/index.js"],
      "enabled": true,
      "environment": {
        "CONFLUENCE_DOMAIN": "company.atlassian.net",
        "CONFLUENCE_EMAIL": "user@example.com",
        "CONFLUENCE_API_TOKEN": "token"
      }
    }
  }
}
```

### From .env File Configuration

If you're using a `.env` file, you have two options:

1. **Keep using .env file**: The server will still read from `.env` if no other configuration is provided
2. **Move to inline configuration**: Copy your environment variables to the OpenCode config
3. **Move to config file**: Create a `.confluence-config.json` file with your settings

## Troubleshooting

### Configuration Not Found

If you see an error about configuration not being found:
1. Verify the `CONFLUENCE_CONFIG_PATH` points to a valid file
2. Check that the file has proper JSON syntax
3. Ensure the file has appropriate read permissions

### Authentication Failures

If authentication fails:
1. Verify your API token is valid and not expired
2. Check that your email matches the Atlassian account
3. Ensure your domain is correct (e.g., `company.atlassian.net`)

### Path Resolution Issues

- The `~` symbol in paths is automatically expanded to your home directory
- Relative paths are resolved from the current working directory
- Use absolute paths when in doubt

## Support

For issues or questions:
- [GitHub Issues](https://github.com/aaronsb/confluence-cloud-mcp/issues)
- [OpenCode Documentation](https://opencode.ai/docs)
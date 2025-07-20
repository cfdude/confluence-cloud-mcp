# Confluence Cloud MCP Configuration Guide

This guide explains how to configure the Confluence Cloud MCP server for single or multiple instances.

## Configuration Methods

The server supports two configuration methods:

1. **Multi-Instance Configuration** (Recommended) - Using `~/.confluence-config.json`
2. **Environment Variables** - For backward compatibility with single instance

## Multi-Instance Configuration

Create a file at `~/.confluence-config.json` with the following structure:

```json
{
  "instances": {
    "instance-name": {
      "domain": "your-domain.atlassian.net",
      "email": "your-email@company.com",
      "apiToken": "your-api-token",
      "spaces": ["SPACE1", "SPACE2"]
    }
  },
  "spaces": {
    "SPACE1": {
      "instance": "instance-name",
      "defaultParentPageId": "123456",
      "defaultLabels": ["team", "docs"]
    }
  },
  "defaultInstance": "instance-name"
}
```

### Configuration Sections

#### `instances` (Required)
Define one or more Confluence instances:

- `domain`: Your Atlassian domain (e.g., `company.atlassian.net`)
- `email`: Email address for authentication
- `apiToken`: API token from [Atlassian Account Settings](https://id.atlassian.com/manage-profile/security/api-tokens)
- `spaces`: Optional array of space keys for auto-discovery

#### `spaces` (Optional)
Configure space-specific settings:

- `instance`: Which instance owns this space
- `defaultParentPageId`: Default parent page for new pages
- `defaultLabels`: Labels automatically added to new pages

#### `defaultInstance` (Optional)
Set the default instance when none is specified.

### Example: Multiple Instances

```json
{
  "instances": {
    "production": {
      "domain": "acme.atlassian.net",
      "email": "john@acme.com",
      "apiToken": "ATATT3xFfGF0...",
      "spaces": ["DOCS", "KB", "API"]
    },
    "development": {
      "domain": "acme-dev.atlassian.net",
      "email": "john@acme.com",
      "apiToken": "ATATT3xFfGF1...",
      "spaces": ["TEST", "SANDBOX"]
    },
    "personal": {
      "domain": "john-personal.atlassian.net",
      "email": "john@personal.com",
      "apiToken": "ATATT3xFfGF2..."
    }
  },
  "spaces": {
    "DOCS": {
      "instance": "production",
      "defaultParentPageId": "98765",
      "defaultLabels": ["official", "reviewed"]
    },
    "TEST": {
      "instance": "development",
      "defaultLabels": ["draft", "testing"]
    }
  },
  "defaultInstance": "production"
}
```

## OAuth2 Configuration

For OAuth2 authentication, use these fields instead:

```json
{
  "instances": {
    "oauth-instance": {
      "domain": "company.atlassian.net",
      "oauthAccessToken": "your-access-token",
      "oauthRefreshToken": "your-refresh-token",
      "oauthClientId": "your-client-id",
      "oauthClientSecret": "your-client-secret"
    }
  }
}
```

## Environment Variables (Single Instance)

For backward compatibility, you can use environment variables:

```bash
export CONFLUENCE_DOMAIN="your-domain.atlassian.net"
export CONFLUENCE_EMAIL="your-email@company.com"
export CONFLUENCE_API_TOKEN="your-api-token"
```

Or for OAuth2:

```bash
export CONFLUENCE_DOMAIN="your-domain.atlassian.net"
export CONFLUENCE_OAUTH_ACCESS_TOKEN="your-access-token"
export CONFLUENCE_OAUTH_REFRESH_TOKEN="your-refresh-token"
export CONFLUENCE_OAUTH_CLIENT_ID="your-client-id"
export CONFLUENCE_OAUTH_CLIENT_SECRET="your-client-secret"
```

## Instance Selection Logic

When a tool is called, the instance is selected using this priority:

1. **Explicit `instance` parameter** - If provided in the tool call
2. **Space mapping** - If the space is configured in the `spaces` section
3. **Auto-discovery** - If the space is listed in an instance's `spaces` array
4. **Default instance** - If `defaultInstance` is configured
5. **Single instance** - If only one instance exists
6. **Error** - Multiple instances with no selection criteria

## Usage Examples

### List spaces from a specific instance:
```json
{
  "tool": "list_confluence_spaces",
  "arguments": {
    "instance": "production"
  }
}
```

### Create a page (instance auto-selected from space):
```json
{
  "tool": "create_confluence_page",
  "arguments": {
    "spaceId": "DOCS",
    "title": "New Page",
    "content": "<p>Content</p>"
  }
}
```

### Search across a specific instance:
```json
{
  "tool": "search_confluence_pages",
  "arguments": {
    "instance": "development",
    "cql": "text ~ 'test'"
  }
}
```

## Tips

1. **Use space mappings** - Configure frequently used spaces in the `spaces` section for automatic instance routing
2. **Set a default** - Configure `defaultInstance` to avoid specifying instance for every operation
3. **Group by purpose** - Organize instances by environment (prod/dev) or purpose (docs/personal)
4. **Use auto-discovery** - List spaces in `instances.{name}.spaces` for automatic routing
5. **Secure your config** - Keep `~/.confluence-config.json` with appropriate file permissions

## Troubleshooting

### "Multiple instances configured" error
- Specify the `instance` parameter in your tool call
- Configure a `defaultInstance`
- Set up space mappings for automatic routing

### "Instance not found" error
- Check instance name spelling
- Verify the instance is defined in `instances` section
- Run `list_confluence_instances` to see available instances

### Authentication failures
- Verify API token is correct and not expired
- Check email matches the Atlassian account
- Ensure domain includes `.atlassian.net`

## Migration from Single Instance

If you're currently using environment variables:

1. Create `~/.confluence-config.json`
2. Move credentials to the JSON format
3. Remove environment variables
4. The server will automatically use the new configuration
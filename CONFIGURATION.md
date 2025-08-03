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

## Cross-Server Integration

The Confluence MCP server supports integration with Jira MCP servers, enabling bidirectional communication and cross-platform workflows.

### Prerequisites

1. **Jira MCP Server** - You need a running Jira MCP server instance
2. **Environment Configuration** - Copy `.env.example` to `.env` and configure cross-server settings

### Configuration

#### Basic Setup

To enable cross-server integration, configure these environment variables in your `.env` file:

```bash
# Enable cross-server integration
CROSS_SERVER_ENABLED=true

# Path to your Jira MCP server
JIRA_MCP_PATH=/Users/yourusername/Servers/mcp-jira/build/index.js

# Connection settings
JIRA_MCP_TIMEOUT=30000
JIRA_MCP_MAX_RETRIES=3
SERVER_POLL_INTERVAL=10000
```

#### Safety Boundaries

Configure which operations are allowed between servers:

```bash
# Operations that can be sent to Jira servers
ALLOWED_OUTGOING_MODES=read,create,update

# Operations that are prohibited
EXCLUDED_OUTGOING_OPERATIONS=delete_issue,delete_project

# Operations that can be received from Jira servers
ALLOWED_INCOMING_MODES=read,create

# Rate limiting
RATE_LIMIT_PER_MINUTE=30
RATE_LIMIT_PER_HOUR=1000
MAX_CROSS_SERVER_BATCH=10
```

### Available Cross-Server Tools

#### 1. Link Confluence to Jira
Create bidirectional links between Confluence pages and Jira issues:

```json
{
  "tool": "link_confluence_to_jira",
  "arguments": {
    "pageId": "123456",
    "jiraKey": "PROJ-123",
    "linkType": "documents",
    "description": "Requirements documentation"
  }
}
```

**Link Types:**
- `documents` - Page documents the Jira issue
- `implements` - Page implements the feature in the issue
- `tests` - Page contains test plans for the issue
- `references` - Page references or relates to the issue

#### 2. Create Confluence from Jira
Generate Confluence pages from Jira issues using templates:

```json
{
  "tool": "create_confluence_from_jira",
  "arguments": {
    "jiraKey": "EPIC-456",
    "templateType": "epic-documentation",
    "spaceId": "DOCS",
    "parentId": "789012"
  }
}
```

**Template Types:**
- `epic-documentation` - Comprehensive epic documentation
- `feature-spec` - Feature specification template
- `meeting-notes` - Meeting notes template

#### 3. Health Checks
Monitor cross-server connectivity:

```json
{
  "tool": "jira_health_check",
  "arguments": {
    "serverPath": "/path/to/jira/server"
  }
}
```

```json
{
  "tool": "confluence_health_check",
  "arguments": {}
}
```

#### 4. Server Discovery
Discover and refresh connections to Jira servers:

```json
{
  "tool": "discover_jira_servers",
  "arguments": {
    "refresh": true
  }
}
```

### Server Roles

The Confluence MCP server operates as the **master** in cross-server relationships:

- **Master (Confluence)** - Initiates connections and polls for Jira servers
- **Slave (Jira)** - Responds to connection requests and provides services

### Connection Flow

1. **Startup** - Confluence server starts and reads cross-server configuration
2. **Discovery** - Searches for configured Jira servers at specified paths
3. **Connection** - Attempts to establish MCP connections to discovered servers
4. **Polling** - Continuously monitors Jira server availability
5. **Integration** - Cross-server tools become available when connections are established

### Monitoring and Troubleshooting

#### Health Check Commands

```bash
# Check Confluence server health
npm run inspector -- --tool confluence_health_check

# Check Jira server connectivity
npm run inspector -- --tool jira_health_check

# Discover available Jira servers
npm run inspector -- --tool discover_jira_servers --args '{"refresh": true}'
```

#### Common Issues

**"No Jira MCP server available"**
- Verify `JIRA_MCP_PATH` points to the correct server file
- Check that the Jira MCP server is built and executable
- Ensure cross-server integration is enabled (`CROSS_SERVER_ENABLED=true`)

**Connection timeouts**
- Increase `JIRA_MCP_TIMEOUT` value
- Check network connectivity between servers
- Verify the Jira server is responding to health checks

**Permission denied errors**
- Review `ALLOWED_OUTGOING_MODES` and `EXCLUDED_OUTGOING_OPERATIONS`
- Check safety boundary configurations
- Verify rate limits are not being exceeded

#### Circuit Breaker

The system includes a circuit breaker pattern to handle Jira server failures:

- **Closed** - Normal operation, requests are sent
- **Open** - Server is failing, requests are blocked
- **Half-Open** - Testing if server has recovered

Circuit breaker settings:
- **Error Threshold** - 5 consecutive failures trigger open state
- **Reset Timeout** - 30 seconds before attempting recovery

### Security Considerations

1. **Operation Filtering** - Use `EXCLUDED_OUTGOING_OPERATIONS` to prevent dangerous operations
2. **Mode Restrictions** - Limit `ALLOWED_OUTGOING_MODES` to only necessary operations
3. **Rate Limiting** - Configure appropriate limits to prevent abuse
4. **Confirmation Requirements** - Set operations that need explicit confirmation

### Example Workflow

Here's a complete workflow for linking documentation:

1. **Create Epic Documentation**
   ```json
   {
     "tool": "create_confluence_from_jira",
     "arguments": {
       "jiraKey": "EPIC-789",
       "templateType": "epic-documentation",
       "spaceId": "ENGINEERING"
     }
   }
   ```

2. **Link Related Issues**
   ```json
   {
     "tool": "link_confluence_to_jira",
     "arguments": {
       "pageId": "created-page-id",
       "jiraKey": "TASK-123",
       "linkType": "implements"
     }
   }
   ```

3. **Monitor Health**
   ```json
   {
     "tool": "jira_health_check",
     "arguments": {}
   }
   ```

This creates a comprehensive documentation structure with bidirectional traceability between Confluence pages and Jira issues.
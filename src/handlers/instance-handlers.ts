import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { listAvailableInstances } from "../config.js";

export async function handleListConfluenceInstances() {
  try {
    const instances = await listAvailableInstances();
    
    // Generate usage examples
    const examples = instances.length > 0 ? [
      {
        description: "List spaces from a specific instance",
        tool: "list_confluence_spaces",
        args: { instance: instances[0].name }
      },
      {
        description: "Search across a specific instance",
        tool: "search_confluence_pages",
        args: { 
          instance: instances[0].name,
          cql: 'text ~ "documentation"'
        }
      }
    ] : [];
    
    const result = {
      instances: instances.map(inst => ({
        name: inst.name,
        domain: inst.domain,
        spaces: inst.spaces || [],
        isDefault: inst.isDefault,
        status: "connected"
      })),
      totalInstances: instances.length,
      configuration: {
        location: "~/.confluence-config.json",
        format: "JSON",
        example: {
          instances: {
            "prod": {
              "domain": "company.atlassian.net",
              "email": "user@company.com",
              "apiToken": "your-api-token",
              "spaces": ["DOCS", "KB"]
            },
            "dev": {
              "domain": "company-dev.atlassian.net",
              "email": "user@company.com",
              "apiToken": "your-api-token",
              "spaces": ["TEST"]
            }
          },
          "spaces": {
            "DOCS": {
              "instance": "prod",
              "defaultParentPageId": "123456",
              "defaultLabels": ["official", "reviewed"]
            }
          },
          "defaultInstance": "prod"
        }
      },
      usage: {
        description: "How to use multiple instances",
        examples: examples,
        tips: [
          "Set 'defaultInstance' to avoid specifying instance for every command",
          "Use 'spaces' mapping to automatically route commands to the right instance",
          "List spaces in 'instances.{name}.spaces' for auto-discovery",
          "Configure space-specific defaults like parent pages and labels"
        ]
      }
    };
    
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error listing instances:", error instanceof Error ? error.message : String(error));
    
    // Check if it's a configuration error
    if (error instanceof Error && error.message.includes('No configuration found')) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No Confluence instances configured",
              help: "Create ~/.confluence-config.json or set environment variables",
              environmentVariables: {
                "CONFLUENCE_DOMAIN": "your-domain.atlassian.net",
                "CONFLUENCE_EMAIL": "your-email@company.com", 
                "CONFLUENCE_API_TOKEN": "your-api-token"
              },
              configExample: {
                instances: {
                  "default": {
                    "domain": "your-domain.atlassian.net",
                    "email": "your-email@company.com",
                    "apiToken": "your-api-token"
                  }
                }
              }
            }, null, 2),
          },
        ],
      };
    }
    
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to list instances: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
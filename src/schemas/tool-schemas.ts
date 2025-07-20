interface ToolSchema {
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const toolSchemas: Record<string, ToolSchema> = {
  list_confluence_instances: {
    description: "List all configured Confluence instances. Shows available instances, their domains, and configuration details. Use this tool to discover which instances are available and how to use them.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  list_confluence_spaces: {
    description: "List all available Confluence spaces. Best used as the first step in a content discovery workflow. Returns space IDs, names, and keys that you can use with other tools. TIP: Use a higher limit (e.g., 100) on first call to get a comprehensive view of available spaces.",
    inputSchema: {
      type: "object",
      properties: {
        instance: {
          type: "string",
          description: "Optional: Specific Confluence instance to use. If not provided, instance will be determined from space context or defaults.",
        },
        limit: {
          type: "number",
          description: "Maximum number of spaces to return (default: 25, max: 250)",
        },
        cursor: {
          type: "string",
          description: "Cursor for pagination, obtained from _links.next",
        },
        sort: {
          type: "string",
          enum: ["name", "-name", "key", "-key"],
          description: "Sort spaces by field (prefix with - for descending)",
        },
      },
    },
  },

  get_confluence_space: {
    description: "Get detailed information about a specific Confluence space. Useful after list_confluence_spaces to examine a space more closely. Returns space metadata including type, status, and homepage information.",
    inputSchema: {
      type: "object",
      properties: {
        instance: {
          type: "string",
          description: "Optional: Specific Confluence instance to use. If not provided, instance will be determined from space context or defaults.",
        },
        spaceId: {
          type: "string",
          description: "ID of the space to retrieve",
        },
      },
      required: ["spaceId"],
    },
  },

  list_confluence_pages: {
    description: "List pages in a specific Confluence space. Essential for content navigation and discovery within a space. Returns page IDs and titles that can be used with get_confluence_page. TIP: Use status filter to find specific page states (current, archived, draft, trashed).",
    inputSchema: {
      type: "object",
      properties: {
        instance: {
          type: "string",
          description: "Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.",
        },
        spaceId: {
          type: "string",
          description: "ID of the space",
        },
        limit: {
          type: "number",
          description: "Maximum number of pages to return (default: 25, max: 250)",
        },
        cursor: {
          type: "string",
          description: "Cursor for pagination, obtained from _links.next",
        },
        sort: {
          type: "string",
          enum: ["created-date", "-created-date", "modified-date", "-modified-date", "title", "-title"],
          description: "Sort pages by field (prefix with - for descending)",
        },
        status: {
          type: "string",
          enum: ["current", "archived", "draft", "trashed"],
          description: "Filter by page status (default: current)",
        },
      },
      required: ["spaceId"],
    },
  },

  get_confluence_page: {
    description: "Get the full content of a specific Confluence page, automatically converted to Markdown format. Essential for reading and understanding page content. Includes metadata like version, author, and last modified date. TIP: Always check the version number before updating a page.",
    inputSchema: {
      type: "object",
      properties: {
        instance: {
          type: "string",
          description: "Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.",
        },
        pageId: {
          type: "string",
          description: "ID of the page to retrieve",
        },
      },
      required: ["pageId"],
    },
  },

  find_confluence_page: {
    description: "Find a page by its title. Useful when you know the page name but not its ID. Can search across all spaces or within a specific space. Returns page details if found, or helpful error if multiple matches exist.",
    inputSchema: {
      type: "object",
      properties: {
        instance: {
          type: "string",
          description: "Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.",
        },
        title: {
          type: "string",
          description: "Exact title of the page to find",
        },
        spaceId: {
          type: "string",
          description: "Optional: Limit search to specific space",
        },
      },
      required: ["title"],
    },
  },

  create_confluence_page: {
    description: "Create a new page in Confluence. Content should be in Confluence storage format (XHTML). Use for adding new documentation, meeting notes, or project pages. TIP: Wrap content in proper HTML tags like <p>, <h1>, <ul>, etc. Returns the created page details including its ID.",
    inputSchema: {
      type: "object",
      properties: {
        instance: {
          type: "string",
          description: "Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.",
        },
        spaceId: {
          type: "string",
          description: "ID of the space where the page will be created",
        },
        title: {
          type: "string",
          description: "Title of the new page",
        },
        content: {
          type: "string",
          description: "Page content in Confluence storage format (XHTML)",
        },
        parentId: {
          type: "string",
          description: "Optional: ID of the parent page",
        },
      },
      required: ["spaceId", "title", "content"],
    },
  },

  update_confluence_page: {
    description: "Update an existing Confluence page. Requires the current version number to prevent conflicts. Content should be in Confluence storage format. IMPORTANT: Always get the current version with get_confluence_page first. TIP: Increment the version number by 1 when updating.",
    inputSchema: {
      type: "object",
      properties: {
        instance: {
          type: "string",
          description: "Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.",
        },
        pageId: {
          type: "string",
          description: "ID of the page to update",
        },
        title: {
          type: "string",
          description: "New title for the page",
        },
        content: {
          type: "string",
          description: "New content in Confluence storage format (XHTML)",
        },
        version: {
          type: "number",
          description: "Current version number of the page (required for conflict detection)",
        },
      },
      required: ["pageId", "title", "content", "version"],
    },
  },

  search_confluence_pages: {
    description: `Search for Confluence content using CQL (Confluence Query Language). Powerful tool for finding pages across spaces.

Common query patterns:
- Find by space: space = "SPACEKEY"
- Find by title: title ~ "search terms"
- Find by text: text ~ "content search"
- Find by label: label = "important"
- Recent changes: lastmodified > now("-7d")
- Combined: space = "DEV" AND text ~ "api" AND lastmodified > now("-30d")

Returns page summaries with IDs for detailed retrieval. TIP: Use ~ for fuzzy matching, = for exact matching.`,
    inputSchema: {
      type: "object",
      properties: {
        instance: {
          type: "string",
          description: "Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.",
        },
        cql: {
          type: "string",
          description: "CQL (Confluence Query Language) query string",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default: 25, max: 100)",
        },
        cursor: {
          type: "string",
          description: "Cursor for pagination, obtained from _links.next",
        },
      },
      required: ["cql"],
    },
  },

  get_confluence_labels: {
    description: "Get all labels attached to a specific page. Labels are key-value tags used for categorization and discovery. Useful for understanding page context and finding related content. Returns label names with their prefixes (global, personal, or team).",
    inputSchema: {
      type: "object",
      properties: {
        instance: {
          type: "string",
          description: "Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.",
        },
        pageId: {
          type: "string",
          description: "ID of the page",
        },
      },
      required: ["pageId"],
    },
  },

  add_confluence_label: {
    description: `Add a label to a Confluence page. Labels help with organization and discovery of related content. 

Format requirements:
- Use only lowercase letters, numbers, hyphens, and underscores
- No spaces allowed (use hyphens instead)
- Examples: "project-alpha", "status-draft", "team-engineering"

Common uses: categorization, workflow states, team ownership, priority marking. Returns success confirmation or error if label already exists.`,
    inputSchema: {
      type: "object",
      properties: {
        instance: {
          type: "string",
          description: "Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.",
        },
        contentId: {
          type: "string",
          description: "ID of the page to add label to",
        },
        prefix: {
          type: "string",
          enum: ["global"],
          description: "Label prefix (must be 'global')",
        },
        name: {
          type: "string",
          description: "Label name (lowercase, no spaces, use hyphens)",
        },
      },
      required: ["contentId", "prefix", "name"],
    },
  },

  remove_confluence_label: {
    description: "Remove a label from a Confluence page. Use when labels are no longer relevant or to clean up page metadata. Requires exact label name as it appears on the page. Returns success confirmation or error if label not found.",
    inputSchema: {
      type: "object",
      properties: {
        instance: {
          type: "string",
          description: "Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.",
        },
        pageId: {
          type: "string",
          description: "ID of the page",
        },
        label: {
          type: "string",
          description: "Exact name of the label to remove",
        },
      },
      required: ["pageId", "label"],
    },
  },
};
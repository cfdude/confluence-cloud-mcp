export const toolSchemas = {
  list_confluence_spaces: {
    description: "List all available Confluence spaces. Best used as the first step in a content discovery workflow. Returns space IDs, names, and keys that you can use with other tools. TIP: Use a higher limit (e.g., 100) on first call to get a comprehensive view of available spaces.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of spaces to return (default: 25)",
        },
        start: {
          type: "number",
          description: "Starting index for pagination (default: 0)",
        },
      },
    },
  },

  get_confluence_space: {
    description: "Get details about a specific space",
    inputSchema: {
      type: "object",
      properties: {
        spaceId: {
          type: "string",
          description: "ID of the space to retrieve",
        },
      },
      required: ["spaceId"],
    },
  },

  list_confluence_pages: {
    description: "List all pages in a Confluence space. Best used when you need to explore all content in a specific space rather than searching for specific terms. Returns page IDs, titles, and metadata. TIP: Use this when search_confluence_pages might miss relevant pages or when you need a complete inventory of pages in a space.",
    inputSchema: {
      type: "object",
      properties: {
        spaceId: {
          type: "string",
          description: "ID of the space to list pages from",
        },
        limit: {
          type: "number",
          description: "Maximum number of pages to return (default: 25)",
        },
        start: {
          type: "number",
          description: "Starting index for pagination (default: 0)",
        },
      },
      required: ["spaceId"],
    },
  },

  get_confluence_page: {
    description: "Get a specific Confluence page by its ID. Returns the complete page content in markdown format, along with metadata like version history and space information. The page ID can be found in search results, page listings, or other API responses. TIP: Save page IDs from searches for direct access to frequently needed pages.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description: "ID of the page to retrieve",
        },
      },
      required: ["pageId"],
    },
  },

  find_confluence_page: {
    description: "Find and retrieve a Confluence page by its title. Returns the page content in markdown format, along with metadata. Optionally specify a spaceId to narrow the search. If multiple pages match the title, returns a list of matches to choose from. TIP: Use this when you know the exact page title, but prefer search_confluence_pages for partial matches.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Title of the page to find",
        },
        spaceId: {
          type: "string",
          description: "Optional space ID to limit the search scope",
        },
      },
      required: ["title"],
    },
  },

  create_confluence_page: {
    description: "Create a new page in a space",
    inputSchema: {
      type: "object",
      properties: {
        spaceId: {
          type: "string",
          description: "ID of the space to create the page in",
        },
        title: {
          type: "string",
          description: "Title of the page",
        },
        content: {
          type: "string",
          description: "Content of the page in Confluence storage format",
        },
        parentId: {
          type: "string",
          description: "ID of the parent page (optional)",
        },
      },
      required: ["spaceId", "title", "content"],
    },
  },

  update_confluence_page: {
    description: "Update an existing page",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description: "ID of the page to update",
        },
        title: {
          type: "string",
          description: "New title of the page",
        },
        content: {
          type: "string",
          description: "New content in Confluence storage format",
        },
        version: {
          type: "number",
          description: "Current version number of the page",
        },
      },
      required: ["pageId", "title", "content", "version"],
    },
  },

  search_confluence_pages: {
    description: "Search across Confluence pages using simple text or CQL (Confluence Query Language).\n\nQuery Types:\n\n1. Simple Text Search:\n   - Just provide the search term directly (e.g., \"documentation\")\n   - The system automatically wraps it in proper CQL syntax\n\n2. Advanced CQL Search:\n   - Must include \"type =\" to signal raw CQL usage\n   - Examples:\n     * type = \"page\" AND text ~ \"project\"\n     * type = \"page\" AND space.key = \"TEAM\"\n     * type = \"page\" AND created >= \"2024-01-01\"\n\nSearch Capabilities:\n- Full text search across all pages\n- Space-specific searches\n- Content type filtering\n- Metadata-based filtering\n\nCQL Operators (for advanced queries):\n- ~ : contains\n- = : equals\n- != : not equals\n- AND, OR : combine conditions\n- () : group conditions\n- >= <= : date comparisons\n- IN : multiple values\n\nCommon Search Patterns:\n- Finding pages in specific space: type = \"page\" AND space.key = \"SPACENAME\" AND text ~ \"searchterm\"\n- Finding recent pages: type = \"page\" AND created >= \"2024-01-01\" AND text ~ \"searchterm\"\n- Finding pages by title: type = \"page\" AND title ~ \"exactname\"\n- Finding pages by label: type = \"page\" AND label = \"labelname\"\n\nResponse includes:\n- Page ID, title, and type\n- Space information\n- URL to the page\n- Last modified date\n- Content excerpt with search term highlighting\n\nPagination:\n- Use 'limit' to control results per page (default: 25)\n- Use 'start' for pagination offset\n\nWorkflow Tips:\n1. Start with list_confluence_spaces to get space keys\n2. Use space-specific searches for better results\n3. Use the returned pageId with get_confluence_page for full content\n4. Look for highlighted excerpts in results to identify most relevant matches\n\nBest Practices:\n1. Start with simple text searches when possible\n2. Use advanced CQL (with 'type =') for complex queries\n3. Use space-specific searches for better performance\n4. Use get_confluence_page to fetch full content of found pages",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query - either simple text (e.g., 'documentation') or CQL query (must include 'type =' for CQL mode, e.g., 'type = \"page\" AND text ~ \"project\"')",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 25)",
        },
        start: {
          type: "number",
          description: "Starting index for pagination (default: 0)",
        },
      },
      required: ["query"],
    },
  },

  get_confluence_labels: {
    description: "Get labels for a page. Use this to understand page categorization and find related content through common labels.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description: "ID of the page",
        },
      },
      required: ["pageId"],
    },
  },

  add_confluence_label: {
    description: "Add a label to a page. Labels help organize content and make it easier to find related pages through search_confluence_pages.\n\nLabel Format:\n- Must contain only letters, numbers, hyphens, and underscores\n- No spaces or special characters allowed\n\nError Handling:\n- Returns 400 for invalid label format\n- Returns 403 for insufficient permissions\n- Returns 404 if page not found\n- Returns 409 if label already exists on the page\n\nResponse includes:\n- Success status\n- Label details (id, name, prefix, creation date)\n- Operation message",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description: "ID of the page to add the label to",
        },
        label: {
          type: "string",
          description: "Label to add (letters, numbers, hyphens, and underscores only)",
        },
      },
      required: ["pageId", "label"],
    },
  },

  remove_confluence_label: {
    description: "Remove a label from a page.\n\nError Handling:\n- Returns 403 for insufficient permissions\n- Returns 404 if page or label not found\n\nResponse includes:\n- Success status\n- Operation details (pageId, label, operation type)\n- Success message",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description: "ID of the page",
        },
        label: {
          type: "string",
          description: "Label to remove",
        },
      },
      required: ["pageId", "label"],
    },
  },
} as const;

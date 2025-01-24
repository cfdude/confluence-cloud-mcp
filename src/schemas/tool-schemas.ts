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
    description: "List all pages in a Confluence space. Best used when you need to explore all content in a specific space rather than searching for specific terms. Returns page IDs, titles, and metadata. TIP: Use this when search_confluence_content might miss relevant pages or when you need a complete inventory of pages in a space.",
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

  get_confluence_page_by_id: {
    description: "Get a specific Confluence page by its ID. This tool is most effectively used after search_confluence_content to get the full content of pages you've found. The page ID can be found in the search results or page listings. Returns the complete page content in markdown format, along with metadata like version history and space information. TIP: Save page IDs from searches for direct access to frequently needed pages.",
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

  get_confluence_page_by_name: {
    description: "Find and retrieve a Confluence page by its title. Returns the page content in markdown format, along with metadata. Optionally specify a spaceId to narrow the search. If multiple pages match the title, returns a list of matches to choose from. TIP: Use this when you know the exact page title, but prefer search_confluence_content for partial matches.",
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

  search_confluence_content: {
    description: "Search across Confluence content using simple text or CQL (Confluence Query Language).\n\nQuery Types:\n\n1. Simple Text Search:\n   - Just provide the search term directly (e.g., \"documentation\")\n   - The system automatically wraps it in proper CQL syntax\n\n2. Advanced CQL Search:\n   - Must include \"type =\" to signal raw CQL usage\n   - Examples:\n     * type = \"page\" AND text ~ \"project\"\n     * type = \"page\" AND space.key = \"TEAM\"\n     * type in (\"page\", \"blogpost\") AND created >= \"2024-01-01\"\n\nSearch Capabilities:\n- Full text search across all content\n- Space-specific searches\n- Content type filtering\n- Metadata-based filtering\n\nCQL Operators (for advanced queries):\n- ~ : contains\n- = : equals\n- != : not equals\n- AND, OR : combine conditions\n- () : group conditions\n- >= <= : date comparisons\n- IN : multiple values\n\nCommon Search Patterns:\n- Finding content in specific space: type = \"page\" AND space.key = \"SPACENAME\" AND text ~ \"searchterm\"\n- Finding recent content: type = \"page\" AND created >= \"2024-01-01\" AND text ~ \"searchterm\"\n- Finding content by title: type = \"page\" AND title ~ \"exactname\"\n- Finding content by label: type = \"page\" AND label = \"labelname\"\n\nResponse includes:\n- Page ID, title, and type\n- Space information\n- URL to the page\n- Last modified date\n- Content excerpt with search term highlighting\n\nPagination:\n- Use 'limit' to control results per page (default: 25)\n- Use 'start' for pagination offset\n\nWorkflow Tips:\n1. Start with list_confluence_spaces to get space keys\n2. Use space-specific searches for better results\n3. Use the returned pageId with get_confluence_page_by_id for full content\n4. Look for highlighted excerpts in results to identify most relevant matches\n\nBest Practices:\n1. Start with simple text searches when possible\n2. Use advanced CQL (with 'type =') for complex queries\n3. Use space-specific searches for better performance\n4. Use get_confluence_page_by_id to fetch full content of found pages",
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
    description: "Add a label to a page. Labels help organize content and make it easier to find related pages through search_confluence_content.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description: "ID of the page",
        },
        label: {
          type: "string",
          description: "Label to add",
        },
      },
      required: ["pageId", "label"],
    },
  },

  remove_confluence_label: {
    description: "Remove a label from a page",
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

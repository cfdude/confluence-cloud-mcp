export const toolSchemas = {
  list_confluence_spaces: {
    description: "List all available Confluence spaces. Use this to discover space IDs that you can use with other tools.",
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
    description: "List all pages in a Confluence space. Returns page IDs, titles, and metadata that you can use with get_confluence_page_by_id.",
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
    description: "Get a specific Confluence page by its ID. Returns the page content in markdown format, along with metadata. This is the most direct way to get a specific page when you know its ID.",
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
    description: "Find and retrieve a Confluence page by its title. Returns the page content in markdown format, along with metadata. Optionally specify a spaceId to narrow the search. If multiple pages match the title, returns a list of matches to choose from.",
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
    description: "Search across all Confluence content using a query string. Use this to find pages when you don't know the exact title. Returns a list of matching pages that you can then get with get_confluence_page_by_id.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to search for in page titles and content",
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
    description: "Get labels for a page",
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
    description: "Add a label to a page",
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

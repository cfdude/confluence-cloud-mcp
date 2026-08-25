interface ToolSchema {
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const toolSchemas: Record<string, ToolSchema> = {
  list_confluence_instances: {
    description:
      'List all configured Confluence instances. Shows available instances, their domains, and configuration details. Use this tool to discover which instances are available and how to use them.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  list_confluence_spaces: {
    description:
      'List all available Confluence spaces. Best used as the first step in a content discovery workflow. Returns space IDs, names, and keys that you can use with other tools. TIP: Use a higher limit (e.g., 100) on first call to get a comprehensive view of available spaces.',
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from space context or defaults.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of spaces to return (default: 25, max: 250)',
        },
        cursor: {
          type: 'string',
          description: 'Cursor for pagination, obtained from _links.next',
        },
        sort: {
          type: 'string',
          enum: ['name', '-name', 'key', '-key'],
          description: 'Sort spaces by field (prefix with - for descending)',
        },
      },
    },
  },

  get_confluence_space: {
    description:
      'Get detailed information about a specific Confluence space. Useful after list_confluence_spaces to examine a space more closely. Returns space metadata including type, status, and homepage information.',
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from space context or defaults.',
        },
        spaceId: {
          type: 'string',
          description: 'ID of the space to retrieve',
        },
      },
      required: ['spaceId'],
    },
  },

  list_confluence_pages: {
    description:
      'List pages in a specific Confluence space. Essential for content navigation and discovery within a space. Returns page IDs, titles, versions and parent IDs -- but no page bodies; read a body with get_confluence_page. TIP: Use status filter to find specific page states (current, archived, draft, trashed).',
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.',
        },
        spaceId: {
          type: 'string',
          description: 'ID of the space',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of pages to return (default: 25, max: 250)',
        },
        cursor: {
          type: 'string',
          description: 'Cursor for pagination, obtained from _links.next',
        },
        sort: {
          type: 'string',
          enum: [
            'created-date',
            '-created-date',
            'modified-date',
            '-modified-date',
            'title',
            '-title',
          ],
          description: 'Sort pages by field (prefix with - for descending)',
        },
        status: {
          type: 'string',
          enum: ['current', 'archived', 'draft', 'trashed'],
          description: 'Filter by page status (default: current)',
        },
      },
      required: ['spaceId'],
    },
  },

  get_confluence_page: {
    description: `Read a Confluence page by ID. Returns "content" (a markdown rendering, for READING), "storage" (the raw Confluence storage format XHTML, the only representation a write may be authored against), "version", "lossy", a heading "outline", and metadata.

THE EDIT LOOP -- follow it exactly:
1. Read the page here. Keep the default format ("both") or use "storage".
2. Changing PART of the page? Pick the heading from "outline" and use replace_confluence_section, append_confluence_section or insert_confluence_section, passing the "version" returned here as their expectedVersion. They splice one section by byte offset, so every byte outside it survives untouched. Prefer this. Rewriting the WHOLE body? Use update_confluence_page.
3. Author the new content as storage-format XHTML, modelled on the "storage" you just read. NEVER send the markdown from "content" to a write tool: Confluence stores markdown syntax literally, so "## Heading" and "**bold**" render as those characters. Write tools reject markdown rather than converting it.

"lossy": true means the markdown rendering flattened something it cannot faithfully represent -- a macro, a layout, or markup this server does not model. When it is true, do not rebuild the page from the markdown; edit the "storage".

"outline": every heading in document order, each with level, text, occurrence (1-based, distinguishing repeated heading text) and addressable. Only addressable headings can be targeted by the section tools. A heading is addressable when it sits at the page root or directly inside a layout container (ac:layout, ac:layout-section, ac:layout-cell). Headings inside macro bodies, table cells, or ordinary wrappers such as <div> are not addressable -- reach those with update_confluence_page.`,
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.',
        },
        pageId: {
          type: 'string',
          description: 'ID of the page to retrieve',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'storage', 'both'],
          description:
            "Which content representations to return (default: 'both'). 'markdown' returns only the readable rendering, under 'content'. 'storage' returns only the raw Confluence storage format, under 'storage' -- this is what a write must be authored against, and it omits 'lossy' because nothing was rendered. 'both' returns each under its own key. 'version', 'outline' and 'metadata' come back for every format. An empty string or null is an error, not a default.",
        },
      },
      required: ['pageId'],
    },
  },

  find_confluence_page: {
    description:
      'Find a page by its exact title and return it in full. The response is identical to get_confluence_page -- "content" (markdown, for reading), "storage" (XHTML, for writing), "version", "lossy" and the heading "outline" -- so see that tool for the read-edit-write loop these fields support. Use this when you know the page name but not its ID. Searches every space unless spaceId is given, and errors asking you to narrow by spaceId when more than one page has the title.',
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.',
        },
        title: {
          type: 'string',
          description: 'Exact title of the page to find (not a substring or fuzzy match)',
        },
        spaceId: {
          type: 'string',
          description:
            'Optional: Limit the search to one space. Supply it when a title is likely to be reused across spaces.',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'storage', 'both'],
          description:
            "Which content representations to return (default: 'both'). 'markdown' returns only the readable rendering, under 'content'. 'storage' returns only the raw Confluence storage format, under 'storage' -- this is what a write must be authored against. 'both' returns each under its own key. 'version', 'outline' and 'metadata' come back for every format.",
        },
      },
      required: ['title'],
    },
  },

  create_confluence_page: {
    description: `Create a new page in a Confluence space. Returns the new page's ID, version and URL.

"content" must be Confluence storage format (XHTML): ordinary elements such as <p>, <h2>, <ul>/<li>, <table>, plus Confluence's own <ac:...> macro markup. Markdown is REJECTED, not converted -- Confluence stores "## Heading" and "**bold**" as those literal characters. Markup that is not well-formed, this server's "[Confluence Macro: ...]" placeholder text, and "$1" markdown-conversion artifacts are rejected too. Every check runs before any request, so a rejected create leaves nothing behind.

To match an existing page's house style, read one with get_confluence_page (format: "storage") and author against that markup.`,
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.',
        },
        spaceId: {
          type: 'string',
          description: 'ID of the space where the page will be created',
        },
        title: {
          type: 'string',
          description: 'Title of the new page',
        },
        content: {
          type: 'string',
          description:
            'Page content in Confluence storage format (XHTML). Not markdown -- markdown is rejected.',
        },
        parentId: {
          type: 'string',
          description:
            "Optional: ID of the parent page. Defaults to the space's configured default parent, if one is set.",
        },
        allowMarkdownContent: {
          type: 'boolean',
          description:
            'Optional: proceed even though the content looks like markdown. Only for prose that genuinely documents markdown syntax outside a code block -- never to push markdown through as page content.',
        },
      },
      required: ['spaceId', 'title', 'content'],
    },
  },

  update_confluence_page: {
    description: `Replace the ENTIRE body of a Confluence page. Every byte of the existing body is discarded and replaced by what you send.

PREFER THE SECTION TOOLS for editing part of a page: replace_confluence_section, append_confluence_section, insert_confluence_section. They splice one section and preserve everything outside it byte-for-byte -- macros, layouts and third-party app markup included. Use this whole-page tool when you are genuinely rewriting the whole body, repairing malformed markup, or editing a region the section tools cannot address (inside a macro body, a table cell, or markup nested in a <div> or similar).

"content" must be Confluence storage format (XHTML). Read the page with get_confluence_page (format: "storage") and author against that markup. NEVER submit the markdown from "content": Confluence stores markdown syntax literally, so "## Heading" renders as those characters.

Rejected before anything is written, in this order: markup that is not well-formed; content that looks like markdown; this server's "[Confluence Macro: ...]" placeholder text; "$1" markdown-conversion artifacts; a body that drops macros or layouts the current page has; a stale expectedVersion. The first four need no request to Confluence at all.

Title and version are handled for you: the title is preserved when omitted, and the server reads the current version and resolves the next one itself -- never compute or increment a version.`,
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.',
        },
        pageId: {
          type: 'string',
          description: 'ID of the page to update',
        },
        title: {
          type: 'string',
          description:
            'Optional: new title for the page. Omit to keep the current title -- do not restate it, because a paraphrase renames the page.',
        },
        content: {
          type: 'string',
          description:
            'The complete new page body in Confluence storage format (XHTML). This replaces the whole body, so it must include everything the page should keep. Not markdown.',
        },
        expectedVersion: {
          type: 'number',
          description:
            'Optional but recommended: the "version" get_confluence_page returned for the content this edit was built on. When supplied, the write fails without modifying the page if someone else changed it in the meantime.',
        },
        confirmConstructRemoval: {
          type: 'boolean',
          description:
            'Optional: confirm that removing macros or layouts present on the current page is intended. Does NOT override a markdown rejection -- if the write was rejected as markdown, the fix is to author storage format, not to set this.',
        },
        allowMarkdownContent: {
          type: 'boolean',
          description:
            'Optional: proceed even though the content looks like markdown. Only for prose that genuinely documents markdown syntax outside a code block -- never to push markdown through as page content.',
        },
      },
      required: ['pageId', 'content'],
    },
  },

  replace_confluence_section: {
    description: `Replace the body of one section of a Confluence page, addressed by its heading. The preferred way to change existing content on part of a page.

The heading itself is retained -- do NOT re-supply it in "content", or the page ends up with two.

SCOPE, read before using: a section runs from its heading to the next heading at the same or a higher level in the same container. NESTED SUBSECTIONS ARE PART OF IT. Replacing an h2 that has h3 subsections under it replaces those subsections and their content too. To rewrite only the prose under one heading, target the deepest heading that covers just that prose; if no such heading exists, include the subsections you want to keep in the replacement content.

Everything outside the section is preserved byte-for-byte: the rest of the page is carried through as raw bytes and never parsed, so macros, layouts and third-party app markup cannot be damaged. That is what makes this safer than update_confluence_page.

"content" must be Confluence storage format (XHTML), never markdown. Read the page with get_confluence_page (format: "storage"), model your markup on what it returns, and pass the "version" it returned as expectedVersion.

Rejected without modifying the page: a heading that is not addressable or does not exist (the error lists the headings that are); an ambiguous heading with no "occurrence"; markup that is not well-formed; content that looks like markdown; "[Confluence Macro: ...]" placeholder text; "$1" conversion artifacts; a replacement that drops a macro or layout the section currently contains; a stale expectedVersion. A page whose STORED markup is already malformed is refused outright, because offsets into repaired markup cannot be trusted -- repair such a page with update_confluence_page.`,
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from page context or defaults.',
        },
        pageId: {
          type: 'string',
          description: 'ID of the page to edit',
        },
        heading: {
          type: 'string',
          description:
            'Text of the heading identifying the section, exactly as get_confluence_page reports it in "outline". Only headings marked addressable can be targeted. Matching ignores surrounding whitespace and curly-vs-straight quotes; letter case is matched exactly first and only then case-insensitively.',
        },
        occurrence: {
          type: 'number',
          description:
            'Optional: which occurrence of a repeated heading to target, as numbered in "outline" (1-based). Required when the heading text matches more than one heading; omitting it then fails with the candidates listed.',
        },
        content: {
          type: 'string',
          description:
            "Required. The section's new body, in Confluence storage format (XHTML). Do not include the heading. Pass an explicit empty string to empty the section -- omitting the field is an error, not an empty body.",
        },
        expectedVersion: {
          type: 'number',
          description:
            'Required: the page "version" get_confluence_page returned for the content this edit was built on, as a JSON number (7, not "7"). A section edit splices at offsets computed from that content, so it refuses to run against a page that has changed since it was read.',
        },
        allowMarkdownContent: {
          type: 'boolean',
          description:
            'Optional: proceed even though the content looks like markdown. Only for prose that genuinely documents markdown syntax outside a code block -- never to push markdown through as page content.',
        },
        confirmConstructRemoval: {
          type: 'boolean',
          description:
            'Optional: confirm that removing macros or layouts present in the section being replaced is intended. Does NOT override a markdown rejection.',
        },
      },
      required: ['pageId', 'heading', 'content', 'expectedVersion'],
    },
  },

  append_confluence_section: {
    description: `Add content to the end of one section of a Confluence page, addressed by its heading. Nothing existing is removed: the section's current body is kept and the new content goes after it.

PLACEMENT: a section ends at the next heading at the same or a higher level, so appending to a heading that has subsections places the content AFTER those subsections, not directly under that heading's own prose. Target the last subsection when that is what you meant.

Everything else on the page is preserved byte-for-byte -- macros, layouts and third-party app markup are carried through as raw bytes and never parsed. Because nothing is removed, there is no construct-removal check and no confirmConstructRemoval parameter.

"content" must be Confluence storage format (XHTML), never markdown. Read the page with get_confluence_page (format: "storage"), model your markup on what it returns, and pass the "version" it returned as expectedVersion. Same rejections as replace_confluence_section, all before anything is written: an unaddressable, missing or ambiguous heading; markup that is not well-formed; markdown; "[Confluence Macro: ...]" placeholder text; "$1" conversion artifacts; a stale expectedVersion; or a page whose own stored markup is malformed (repair that with update_confluence_page).`,
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from page context or defaults.',
        },
        pageId: {
          type: 'string',
          description: 'ID of the page to edit',
        },
        heading: {
          type: 'string',
          description:
            'Text of the heading identifying the section, exactly as get_confluence_page reports it in "outline". Only headings marked addressable can be targeted. Matching ignores surrounding whitespace and curly-vs-straight quotes; letter case is matched exactly first and only then case-insensitively.',
        },
        occurrence: {
          type: 'number',
          description:
            'Optional: which occurrence of a repeated heading to target, as numbered in "outline" (1-based). Required when the heading text matches more than one heading.',
        },
        content: {
          type: 'string',
          description:
            'Required. The content to add at the end of the section, in Confluence storage format (XHTML). Omitting the field is an error rather than a no-op. No whitespace or separator is inserted around it.',
        },
        expectedVersion: {
          type: 'number',
          description:
            'Required: the page "version" get_confluence_page returned for the content this edit was built on, as a JSON number (7, not "7"). A section edit splices at offsets computed from that content, so it refuses to run against a page that has changed since it was read.',
        },
        allowMarkdownContent: {
          type: 'boolean',
          description:
            'Optional: proceed even though the content looks like markdown. Only for prose that genuinely documents markdown syntax outside a code block -- never to push markdown through as page content.',
        },
      },
      required: ['pageId', 'heading', 'content', 'expectedVersion'],
    },
  },

  insert_confluence_section: {
    description: `Insert a new section immediately after an existing section of a Confluence page. Use this to add a section without touching any existing content.

The section named by "heading" -- including any subsections nested under it -- is left unchanged. The new heading and body are spliced in at the point where that section ends, and everything else on the page is preserved byte-for-byte, macros and layouts included. Nothing is removed, so there is no construct-removal check.

"newHeading" is PLAIN TEXT: it is escaped and wrapped in a heading element for you, so do not send "<h2>...</h2>" or "## ...". "content" is the new section's body in Confluence storage format (XHTML) and may be omitted for a heading with no body yet.

Read the page with get_confluence_page (format: "storage") first, model your markup on what it returns, and pass the "version" it returned as expectedVersion. Same rejections as replace_confluence_section, all before anything is written: an unaddressable, missing or ambiguous heading; markup that is not well-formed; markdown; "[Confluence Macro: ...]" placeholder text; "$1" conversion artifacts; a stale expectedVersion; or a page whose own stored markup is malformed (repair that with update_confluence_page).`,
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from page context or defaults.',
        },
        pageId: {
          type: 'string',
          description: 'ID of the page to edit',
        },
        heading: {
          type: 'string',
          description:
            'Text of the heading identifying the EXISTING section the new one goes after, exactly as get_confluence_page reports it in "outline". Only headings marked addressable can be targeted. Matching ignores surrounding whitespace and curly-vs-straight quotes; letter case is matched exactly first and only then case-insensitively.',
        },
        occurrence: {
          type: 'number',
          description:
            'Optional: which occurrence of a repeated heading to target, as numbered in "outline" (1-based). Required when the heading text matches more than one heading.',
        },
        newHeading: {
          type: 'string',
          description:
            "Plain text of the new section's heading. Do not supply markup or markdown -- the heading element is built for you and the text is escaped.",
        },
        level: {
          type: 'number',
          description:
            'Optional: heading level (1-6) for the new section. Defaults to the level of the section named by "heading", which makes the new section a sibling of it.',
        },
        content: {
          type: 'string',
          description:
            'Optional. Body of the new section, in Confluence storage format (XHTML). Omit for a heading with no body. No whitespace is inserted between the heading and this body.',
        },
        expectedVersion: {
          type: 'number',
          description:
            'Required: the page "version" get_confluence_page returned for the content this edit was built on, as a JSON number (7, not "7"). A section edit splices at offsets computed from that content, so it refuses to run against a page that has changed since it was read.',
        },
        allowMarkdownContent: {
          type: 'boolean',
          description:
            'Optional: proceed even though the content looks like markdown. Only for prose that genuinely documents markdown syntax outside a code block -- never to push markdown through as page content.',
        },
      },
      required: ['pageId', 'heading', 'newHeading', 'expectedVersion'],
    },
  },

  validate_confluence_content: {
    description: `Check content against every write-safety rule BEFORE submitting it. Read-only -- this tool never modifies a page, and validating reserves nothing.

The cheap pre-flight for create_confluence_page, update_confluence_page and the three section tools. Those tools run the SAME checks in the same order and reject on the FIRST failure, so a rejected write reveals one problem per attempt. This runs the identical pipeline and reports ALL of them at once, each with what is wrong, where, and the concrete corrective action. Fix everything, validate again, then write.

"content" is the Confluence storage format (XHTML) you intend to send -- a whole page body, or the fragment you would hand to a section tool. Never markdown.

WITHOUT pageId, no request is made to Confluence at all, and four checks run: markup that is not well-formed; markdown submitted as storage; this server's "[Confluence Macro: ...]" placeholder text; "$1" markdown-conversion artifacts. That is the COMPLETE verdict for create_confluence_page, append_confluence_section and insert_confluence_section -- none of them removes anything.

WITH pageId, the page is read (and only read) so one further check runs: whether the content drops macros or layouts the page currently has. By default that comparison is whole-page, exactly matching update_confluence_page.

VALIDATING A replace_confluence_section FRAGMENT? Pass pageId AND heading (plus occurrence if the heading repeats). The comparison is then scoped to the exact span that tool would replace, using the same resolver it uses -- so macros living in OTHER sections are correctly ignored. Passing pageId without heading would report them as about to be lost and reject a fragment that would in fact write cleanly.

Returns "valid" as a boolean for the common case, the checks that ran, any that did not and why, and "problems" ordered as the write path would hit them (the first is the one a write would be rejected on). With pageId it also returns the page's current version, ready to pass as expectedVersion.

A clean result is about CONTENT. A write can still fail afterwards on a stale expectedVersion if someone else edits the page in between.`,
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. Only consulted when pageId is supplied; without a pageId this tool contacts no instance at all.',
        },
        content: {
          type: 'string',
          description:
            'Required. The Confluence storage format (XHTML) you intend to write -- a whole page body or a section fragment. Pass an explicit empty string to validate empty content; omitting the field is an error, not empty content.',
        },
        pageId: {
          type: 'string',
          description:
            "Optional: the page this content is destined for. Supply it to also check, against that page's current body, whether the write would drop macros or layouts -- the one check that needs a comparison target. Also returns the page's current version, ready to pass as expectedVersion. Omit it for create_confluence_page and for append/insert section edits, which remove nothing. For a replace_confluence_section fragment, supply it together with \"heading\".",
        },
        heading: {
          type: 'string',
          description:
            'Optional, and only meaningful with pageId: the heading of the section this content will replace. Scopes the macro/layout-loss comparison to exactly the span replace_confluence_section would replace, instead of comparing against the whole page. Without it, a fragment for one section is judged against every macro on the page and rejected for losses that would never occur.',
        },
        occurrence: {
          type: 'number',
          description:
            'Optional: 1-based index disambiguating a repeated heading, exactly as the section-edit tools use it. Take it from the outline get_confluence_page returns.',
        },
        allowMarkdownContent: {
          type: 'boolean',
          description:
            'Optional: mirror the flag you intend to pass to the write. It suppresses the markdown check here exactly as it does on the write path, so the verdict matches the write you actually plan to make. Echoed back under "overridesApplied" so a waived check is never mistaken for a clean one.',
        },
        confirmConstructRemoval: {
          type: 'boolean',
          description:
            'Optional: mirror the flag you intend to pass to the write. It waives the construct-removal check here exactly as it does on the write path. Echoed back under "overridesApplied".',
        },
      },
      required: ['content'],
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

Returns page summaries with IDs, not page bodies -- read a body with get_confluence_page. TIP: Use ~ for fuzzy matching, = for exact matching.`,
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.',
        },
        cql: {
          type: 'string',
          description: 'CQL (Confluence Query Language) query string',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 25, max: 100)',
        },
        cursor: {
          type: 'string',
          description: 'Cursor for pagination, obtained from _links.next',
        },
      },
      required: ['cql'],
    },
  },

  get_confluence_labels: {
    description:
      'Get all labels attached to a specific page. Labels are tags used for categorization and discovery. Useful for understanding page context and finding related content -- a label found here can be fed straight back into search_confluence_pages as `label = "name"`. Returns label names with their prefixes (global, personal, or team).',
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.',
        },
        pageId: {
          type: 'string',
          description: 'ID of the page',
        },
      },
      required: ['pageId'],
    },
  },

  add_confluence_label: {
    description: `Add a label to a Confluence page. Labels help with organization and discovery of related content, and do not touch the page body or its version.

Format requirements:
- Use only lowercase letters, numbers, hyphens, and underscores
- No spaces allowed (use hyphens instead)
- Examples: "project-alpha", "status-draft", "team-engineering"

Common uses: categorization, workflow states, team ownership, priority marking. Returns success confirmation or error if label already exists.`,
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.',
        },
        contentId: {
          type: 'string',
          description: 'ID of the page to add label to',
        },
        prefix: {
          type: 'string',
          enum: ['global'],
          description: "Label prefix (must be 'global')",
        },
        name: {
          type: 'string',
          description: 'Label name (lowercase, no spaces, use hyphens)',
        },
      },
      required: ['contentId', 'prefix', 'name'],
    },
  },

  remove_confluence_label: {
    description:
      'Remove a label from a Confluence page. Use when labels are no longer relevant or to clean up page metadata. Requires the exact label name as get_confluence_labels reports it. Does not touch the page body or its version. Returns success confirmation or error if label not found.',
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from space/page context or defaults.',
        },
        pageId: {
          type: 'string',
          description: 'ID of the page',
        },
        label: {
          type: 'string',
          description: 'Exact name of the label to remove',
        },
      },
      required: ['pageId', 'label'],
    },
  },

  // Page movement tool
  move_confluence_page: {
    description:
      'Move a Confluence page to a new location by re-parenting it. The destination space is whichever space the target parent lives in, so this is also how a page moves between spaces, and the page keeps its ID and its child pages. This changes only the page hierarchy -- the page body is not read, rewritten, or versioned by this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description:
            'Optional: Specific Confluence instance to use. If not provided, instance will be determined from page context or defaults.',
        },
        pageId: {
          type: 'string',
          description: 'ID of the page to move',
        },
        targetParentId: {
          type: 'string',
          description: 'ID of the target parent page where the page will be moved',
        },
        position: {
          type: 'string',
          enum: ['append', 'before', 'after'],
          description:
            "Position relative to the target parent (default: append). 'append' nests the page under the target as its last child; 'before'/'after' place it as a sibling of the target.",
        },
      },
      required: ['pageId', 'targetParentId'],
    },
  },
};

# Confluence Cloud MCP Server

A Model Context Protocol (MCP) server that provides tools for interacting with Confluence Cloud. This server enables AI assistants to manage Confluence spaces, pages, and content through a standardized interface.

**Now with multi-instance support!** Work with multiple Confluence instances seamlessly. See [CONFIGURATION.md](CONFIGURATION.md) for details.

[![CI/CD Pipeline](https://github.com/cfdude/confluence-cloud-mcp/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/cfdude/confluence-cloud-mcp/actions/workflows/ci-cd.yml)

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
  - Edit a single section in place, preserving the rest of the page byte-for-byte
  - Render page content from Confluence storage format to Markdown for reading
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
  ghcr.io/cfdude/confluence-cloud-mcp:latest
```

### Option 2: Building Locally

1. Clone the repository:
```bash
git clone https://github.com/cfdude/confluence-cloud-mcp.git
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
      "args": ["run", "--rm", "-i", "ghcr.io/cfdude/confluence-cloud-mcp:latest"],
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

## Available Tools (17)

### Instance Management
- `list_confluence_instances`: List all configured Confluence instances

### Space Tools
- `list_confluence_spaces`: List all spaces in Confluence
- `get_confluence_space`: Get details about a specific space

### Page Tools
- `list_confluence_pages`: List pages in a space
- `get_confluence_page`: Read a page. Returns `content` (Markdown, for reading), `storage` (XHTML, the only representation a write may be authored against), `version`, `lossy`, and a heading `outline`
- `find_confluence_page`: Find a page by exact title across spaces, returning the same payload as `get_confluence_page`
- `create_confluence_page`: Create a new page in a space (content in storage format)
- `update_confluence_page`: Replace a whole page's body -- the escape hatch for whole-page rewrites and for regions the section tools cannot address. Title is optional and preserved when omitted; the server resolves the version itself
- `move_confluence_page`: Move a page to a new parent or space

### Section Tools
- `replace_confluence_section`: Replace the body of one section, identified by its heading (the heading itself is retained)
- `append_confluence_section`: Append content to the end of one section
- `insert_confluence_section`: Insert a new section after an existing one (`newHeading` is plain text and is escaped for you)

### Validation Tools
- `validate_confluence_content`: Check content against every write-safety rule **before**
  submitting it, without writing anything. Runs the same preflight pipeline the write tools
  run, but reports **all** problems instead of stopping at the first -- each with what is
  wrong, where, and the corrective action.

  Without `pageId` it makes no request to Confluence at all and runs the four
  content-intrinsic checks (well-formedness, markdown-as-storage, macro placeholder, `$1`
  artifacts) -- the complete verdict for `create_confluence_page` and for append/insert
  section edits. With `pageId` the page is read (only read) and construct-loss also runs,
  whole-page, matching `update_confluence_page`. Omit `pageId` when validating a
  `replace_confluence_section` fragment: that tool scopes the same check to the replaced
  section, so a whole-page comparison would report losses that are not real.

**Prefer these over `update_confluence_page` for any partial edit.** A section edit splices a
single span by computed byte offsets, so every byte outside the edited section -- macros,
layouts and third-party app markup included -- is carried through unchanged and never parsed.
They require `expectedVersion` (the `version` returned by `get_confluence_page`, as a JSON
number) so an edit cannot splice into content that changed since it was read.

Two things to know before using them:

- **A section runs from its heading to the next heading at the same or a higher level**, so
  nested subsections are part of it. Replacing an `h2` that has `h3` children replaces those
  children too, and appending to it lands *after* them.
- **Only `addressable` headings can be targeted.** The `outline` from `get_confluence_page`
  flags each one. A heading is addressable when it sits at the page root or directly inside a
  layout container (`ac:layout`, `ac:layout-section`, `ac:layout-cell`). Headings inside macro
  bodies, table cells, or ordinary wrappers such as `<div>` are not -- reach those with
  `update_confluence_page`. A page whose stored markup is already malformed is refused outright,
  since offsets into repaired markup cannot be trusted; repair it with `update_confluence_page`.

### Reading vs writing content

`get_confluence_page` and `find_confluence_page` accept `format`: `markdown`, `storage`, or
`both` (default). Markdown is a **lossy rendering meant for reading** -- the response sets
`lossy` when the page contains anything markdown cannot faithfully represent (macros, layouts,
and markup this server does not model), and returns a heading `outline` marking which headings
can be targeted by a section edit.

**Writes must supply storage format (XHTML), not markdown.** Confluence stores markdown syntax
literally rather than rendering it, so submitted markdown is rejected with guidance to read the
page with `format: "storage"` and author against that markup.

Every write runs the same preflight, in a fixed order, before any request that would modify a
page:

1. **Well-formedness** -- unclosed or misnested markup is rejected.
2. **Markdown** -- `##` headings, `**emphasis**` and triple-backtick fences outside a code
   region are rejected. Bare `-`/`*` bullets are deliberately *not* rejected on their own,
   since they appear in legitimate prose. Override with `allowMarkdownContent` only for prose
   that genuinely documents markdown syntax.
3. **Macro placeholder** -- this server's own `[Confluence Macro: ...]` label, which appears
   in the Markdown rendering, is rejected on the way back in.
4. **Conversion artifacts** -- the `$1` text the old converter emitted in place of ordered-list
   item content.
5. **Construct loss** -- a write that drops macros or layouts the current page has. Override
   with `confirmConstructRemoval`. This does *not* override a markdown rejection, and it does
   not apply to `create_confluence_page` (no prior version) or to append/insert (nothing is
   removed).

A stale `expectedVersion` fails the same way, without modifying the page.

The markdown conversion handles:
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

Released under the [MIT License](LICENSE).

## Credits

This project began as a fork of `aaronsb/confluence-cloud-mcp` by Aaron Bockelie, which laid the
original foundation for this server. That repository is no longer available; this one is now
maintained independently by Rob Sherman. Thanks to Aaron for the original work.

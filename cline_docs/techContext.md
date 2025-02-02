# Technical Context

## Technologies Used
- TypeScript
- Node.js
- @modelcontextprotocol/sdk: MCP server implementation
- @atlaskit/adf-schema: Atlassian Document Format schema
- @atlaskit/adf-utils: Utilities for ADF manipulation
- @atlaskit/editor-json-transformer: ADF transformation tools
- axios: HTTP client for API requests
- dotenv: Environment variable management

## Development Setup
- Build system: TypeScript compiler (tsc)
- Build command: `npm run build`
- Watch mode available: `npm run watch`
- Inspector tool: `npm run inspector`

## Technical Constraints
1. API Limitations
   - Must handle Confluence API rate limits
   - Authentication via environment variables
   - API version compatibility requirements

2. Data Format Requirements
   - Content must be in Confluence storage format
   - Label naming restrictions (alphanumeric, hyphens, underscores)
   - Version number tracking for page updates

3. Tool Implementation
   - Must follow [verb]_confluence_[noun] naming pattern
   - Input validation through JSON Schema
   - Error handling with specific status codes

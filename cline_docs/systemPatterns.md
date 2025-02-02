# System Patterns

## Architecture
- Built as a Model Context Protocol (MCP) server
- TypeScript-based implementation
- Uses Atlassian SDK for Confluence Cloud integration

## Key Technical Decisions
1. Tool Naming Convention
   - Format: [verb]_confluence_[noun]
   - Examples: list_confluence_spaces, get_confluence_page_by_id
   - Consistent naming for better discoverability and understanding

2. Input Schema Pattern
   - JSON Schema based validation
   - Required parameters clearly marked
   - Optional parameters with defaults where appropriate
   - Clear parameter descriptions

3. Error Handling
   - Structured error responses
   - HTTP status code mapping
   - Descriptive error messages

## Core Components
1. Tool Schemas
   - Defined in src/schemas/tool-schemas.ts
   - Contains tool definitions and input validation schemas

2. Handlers
   - Organized by functionality (pages, spaces, labels)
   - Located in src/handlers/
   - Implement tool business logic

3. Client
   - Confluence API client implementation
   - Handles authentication and API communication

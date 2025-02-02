# Active Context

## Current Task
Standardizing tool names to follow the [verb]_confluence_[noun] convention consistently.

## Recent Changes
1. Updated tool schemas in src/schemas/tool-schemas.ts:
   - Renamed `get_confluence_page_by_id` to `get_confluence_page`
   - Renamed `get_confluence_page_by_name` to `find_confluence_page`
   - Renamed `search_confluence_content` to `search_confluence_pages`
   - Updated all cross-references in tool descriptions

2. Updated handler implementations in src/handlers/page-handlers.ts:
   - Renamed handler functions to match new tool names
   - Updated error messages and references

3. Updated handler implementations in src/handlers/search-label-handlers.ts:
   - Renamed search handler to `handleSearchConfluencePages`
   - Updated error messages and references

4. Updated main server implementation in src/index.ts:
   - Updated imports to use new handler names
   - Updated tool handler mappings in switch statement
   - Updated error messages and references

## Next Steps
All changes have been completed. The tool names now consistently follow the [verb]_confluence_[noun] pattern. The server can be rebuilt and tested with the new tool names.

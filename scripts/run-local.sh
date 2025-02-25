#!/bin/bash
set -e

# Check if environment variables are provided
if [ -z "$CONFLUENCE_API_TOKEN" ]; then
    echo "Error: CONFLUENCE_API_TOKEN environment variable is required"
    echo "Usage: CONFLUENCE_API_TOKEN=your_token CONFLUENCE_EMAIL=your_email ./scripts/run-local.sh"
    exit 1
fi

if [ -z "$CONFLUENCE_EMAIL" ]; then
    echo "Error: CONFLUENCE_EMAIL environment variable is required"
    echo "Usage: CONFLUENCE_API_TOKEN=your_token CONFLUENCE_EMAIL=your_email ./scripts/run-local.sh"
    exit 1
fi

# Optional CONFLUENCE_DOMAIN environment variable
CONFLUENCE_DOMAIN_ARG=""
if [ -n "$CONFLUENCE_DOMAIN" ]; then
    CONFLUENCE_DOMAIN_ARG="-e CONFLUENCE_DOMAIN=$CONFLUENCE_DOMAIN"
fi

# Run local development image with provided credentials
echo "Starting confluence-cloud MCP server..."
docker run --rm -i \
  -e CONFLUENCE_API_TOKEN=$CONFLUENCE_API_TOKEN \
  -e CONFLUENCE_EMAIL=$CONFLUENCE_EMAIL \
  $CONFLUENCE_DOMAIN_ARG \
  confluence-cloud-mcp:local

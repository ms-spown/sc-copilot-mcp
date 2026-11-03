#!/bin/bash

set -e

echo "Building SCMCP..."
npm ci --ignore-scripts
npm run build

MCP_COMMAND="node $(pwd)/dist/index.js"
MCP_ENV="UEXTOKEN=$UEXTOKEN"

echo ""
echo "Attempting to install Star Citizen MCP for Claude Code..."
if command -v claude &> /dev/null; then
    claude mcp add scmcp $MCP_COMMAND
    echo "✅ Successfully added to Claude Code."
else
    echo "⚠️  Claude Code CLI not found. Skipping."
fi

echo ""
echo "Attempting to install Star Citizen MCP for Gemini CLI..."
if command -v gemini &> /dev/null; then
    # Assuming Gemini uses a similar plugin command or config structure
    gemini mcp add scmcp $MCP_COMMAND
    echo "✅ Successfully added to Gemini."
else
    echo "⚠️  Gemini CLI not found. To manually add, use the following command:"
    echo "node $(pwd)/dist/index.js"
fi

echo ""
echo "Installation process finished! Don't forget to set your UEXTOKEN in your environment or MCP config if you haven't already."
#!/bin/bash
# Playwright wrapper for bowser commands (without persistent sessions)

PLAYWRIGHT_MCP_VIEWPORT_SIZE=1440x900 ./node_modules/.bin/playwright open "$@" --browser chromium

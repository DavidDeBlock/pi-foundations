#!/bin/bash

# Pi Hub — Skill Validation Script
# Validates that all skills in AGENTS.md exist and are properly structured

set -e

SKILLS_DIR=".pi/skills"
AGENT_FILE="$HOME/.pi/agent/AGENTS.md"
INDEX_FILE=".pi/INDEX.md"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🔍 Pi Hub Skill Validation"
echo "=========================="
echo ""

ERRORS=0
WARNINGS=0

# Check if AGENTS.md exists
if [ ! -f "$AGENT_FILE" ]; then
    echo -e "${RED}❌ ERROR: Global AGENTS.md not found at $AGENT_FILE${NC}"
    exit 1
fi

echo "✅ Global AGENTS.md found"

# Extract skill names from AGENTS.md (from the Available Agents table)
# Format: | **Builder** | `typescript-implementer` | Implementation | Purpose |
# Filter out Definition of Done section by excluding lines without backticks in column 2
SKILLS_IN_AGENTS=$(grep -E '^\| \*\*' "$AGENT_FILE" | grep -v "clear enough\|structural place\|migration plan\|Slice works\|next action" | awk -F'|' '{print $3}' | sed 's/[ *`"]//g')

echo ""
echo "📋 Checking skills from AGENTS.md..."

for skill in $SKILLS_IN_AGENTS; do
    SKILL_PATH="$SKILLS_DIR/$skill/SKILL.md"
    
    if [ ! -d "$SKILLS_DIR/$skill" ]; then
        echo -e "${RED}❌ MISSING: Skill directory '$skill' does not exist${NC}"
        ERRORS=$((ERRORS + 1))
        continue
    fi
    
    if [ ! -f "$SKILL_PATH" ]; then
        echo -e "${RED}❌ MISSING: SKILL.md for '$skill' does not exist${NC}"
        ERRORS=$((ERRORS + 1))
        continue
    fi
    
    # Check for required sections in SKILL.md (flexible naming)
    if ! grep -qE "^## (Mission|Purpose)" "$SKILL_PATH"; then
        echo -e "${YELLOW}⚠️  WARNING: '$skill' missing Mission/Purpose section${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi
    if ! grep -q "^## Primary Responsibility" "$SKILL_PATH"; then
        echo -e "${YELLOW}⚠️  WARNING: '$skill' missing Primary Responsibility section${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi
    if ! grep -q "^## Focus" "$SKILL_PATH"; then
        echo -e "${YELLOW}⚠️  WARNING: '$skill' missing Focus section${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi
    
    echo -e "${GREEN}✅ ${skill}${NC}"
done

# Check INDEX.md references
echo ""
echo "📋 Checking INDEX.md references..."

if [ ! -f "$INDEX_FILE" ]; then
    echo -e "${RED}❌ ERROR: INDEX.md not found${NC}"
    ERRORS=$((ERRORS + 1))
else
    # Check if all skills are listed in INDEX.md
    for skill in $SKILLS_IN_AGENTS; do
        if ! grep -q "$skill" "$INDEX_FILE"; then
            echo -e "${YELLOW}⚠️  WARNING: '$skill' not referenced in INDEX.md${NC}"
            WARNINGS=$((WARNINGS + 1))
        fi
    done
    
    # Check for skills in directory but not in INDEX.md
    for skill_dir in "$SKILLS_DIR"/*/; do
        skill=$(basename "$skill_dir")
        if [ -f "$skill_dir/SKILL.md" ] && ! grep -q "$skill" "$INDEX_FILE"; then
            echo -e "${YELLOW}⚠️  WARNING: '$skill' exists but not in INDEX.md${NC}"
            WARNINGS=$((WARNINGS + 1))
        fi
    done
    
    echo -e "${GREEN}✅ INDEX.md references validated${NC}"
fi

# Summary
echo ""
echo "=========================="
echo "📊 Validation Summary"
echo "=========================="

if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}✅ All checks passed!${NC}"
    exit 0
else
    if [ $ERRORS -gt 0 ]; then
        echo -e "${RED}❌ Errors: $ERRORS${NC}"
    fi
    if [ $WARNINGS -gt 0 ]; then
        echo -e "${YELLOW}⚠️  Warnings: $WARNINGS${NC}"
    fi
    exit 1
fi

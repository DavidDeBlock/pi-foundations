#!/usr/bin/env python3
"""Scrape Skeleton documentation from skeleton.dev"""

import os
import sys
from pathlib import Path

# Add scripts directory to path
sys.path.insert(0, str(Path(__file__).parent))

# Import scrape functions
import subprocess

SKELETON_BASE = "https://www.skeleton.dev/docs/svelte"
OUTPUT_DIR = Path(__file__).parent.parent.parent.parent / "library" / "docs" / "skeleton" / "website"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Documentation pages to scrape
DOCS = [
    # Get Started
    "get-started/introduction",
    "get-started/installation",
    "get-started/fundamentals",
    "get-started/core-api",
    "get-started/migrate-from-v2",
    "get-started/migrate-from-v3",
    # Guides
    "guides/mode",
    "guides/layouts",
    "guides/cookbook",
    # Design System
    "design/themes",
    "design/colors",
    "design/presets",
    "design/typography",
    "design/spacing",
    "design/iconography",
    # Components
    "tailwind-components/badges",
    "tailwind-components/buttons",
    "tailwind-components/cards",
    "tailwind-components/chips",
    "tailwind-components/dividers",
    "tailwind-components/forms",
    "tailwind-components/placeholders",
    "tailwind-components/tables",
    # Resources
    "resources/contribute",
    "resources/llms",
]

def main():
    from scrape_website import scrape_url
    
    count = 0
    for doc in DOCS:
        url = f"{SKELETON_BASE}/{doc}"
        output_file = OUTPUT_DIR / f"{doc.split('/')[-1]}.md"
        output_file.parent.mkdir(parents=True, exist_ok=True)
        
        print(f"Fetching: {doc}")
        result = subprocess.run(
            ["curl", "-sL", url],
            capture_output=True,
            text=True
        )
        
        if result.returncode == 0 and result.stdout:
            # Save raw HTML for now
            with open(str(output_file).replace('.md', '.html'), 'w', encoding='utf-8') as f:
                f.write(result.stdout)
            count += 1
            print(f"  Saved: {output_file.name}")
    
    print(f"\nDownloaded {count} documentation pages")
    print(f"Location: {OUTPUT_DIR}")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Playwright session wrapper for restaurant research"""
import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            args=[
                '--disable-gpu',
                '--no-sandbox'
            ]
        )
        context = await browser.new_context(
            viewport={'width': 1440, 'height': 900}
        )
        
        # Enable console logging
        page = await context.new_page()
        
        @page.on('console', lambda msg: print(f"[{msg.type}] {msg.text}"))
        def on_console(msg):
            print(f"[{msg.type}] {msg.text}")
            
        @page.on('pageerror', lambda error: print(f"PAGE ERROR: {error}"))
        def on_error(error):
            print(f"PAGE ERROR: {error}")
        
        await page.goto("https://www.google.com/search?q=top+restaurants+Gent+Belgium")
        await page.wait_for_load_state('networkidle')
        
        # Keep browser open for inspection
        input("\nPress Enter to close...")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())

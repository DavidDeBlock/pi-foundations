# a4-math

A single-page web tool for generating A4-sized printable math worksheets for early-primary addition and subtraction practice.

No build step, no dependencies. Open `index.html` in any modern browser.

## Use

1. Open `index.html` (double-click or `python3 -m http.server` from the folder).
2. Pick your settings in the top panel.
3. Click **Generate** to (re)roll the worksheet.
4. Click **Print** — choose "Save as PDF" or send to a printer. The browser's A4 output is sized to fit a real sheet.

## Options

| Option | What it does |
|---|---|
| Operation | Addition, subtraction, or mixed (random per problem) |
| Min / Max | Inclusive numeric range for both operands |
| Problems per page | 20 (4×5), 30 (3×10), 40 (4×10) |
| Allow borrowing | Subtraction only — when off, every digit column resolves without borrow |
| Answer key page | Adds a second printable page with answers filled in |
| Page title | Free text printed in the header (e.g. "Week 3 — Tuesday") |

## Layout

- Each problem is laid out vertically in monospace, right-aligned, so digits line up for clean hand-writing.
- Subtraction is rendered with the unicode minus `−` (slightly nicer than a hyphen in print).
- Print CSS uses `@page { size: A4; margin: 0 }` and the page container is exactly 210mm × 297mm, so what you preview is what you get.
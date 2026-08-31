# Citation Counter

Per-page citation analysis for PDFs, running entirely in the browser.

**Live:** <https://tools.pike.im/citation-counter/>

## What it does

Drop a PDF onto the page (or click to browse) and it:

- Counts citations per page. Citation styles — numeric (`[12]`), parenthetical
  numbers, superscripts (Vancouver) and author–year (`(Smith et al., 2020)`,
  `Smith (2020)`) — are auto-detected per document; uncheck **Auto-detect**
  to choose styles manually.
- Optionally stops counting at the References / Bibliography section.
- Cross-checks the parsed reference list against in-text citations.
- Shows stats: total citations, citations per 1k words, per-page density.
- Draws a customisable chart (title, axis labels, bar/line colours) of
  citations per page plus cumulative count.
- Hover any chart to download it directly as PNG or SVG; the underlying
  data exports as CSV.

## Privacy / how it works

The whole tool is a single self-contained `index.html` with
[pdf.js](https://mozilla.github.io/pdf.js/) (Mozilla, Apache-2.0) bundled
inline. Everything is processed locally in your browser — nothing is
uploaded, no network calls are made, and the page works offline.

## Development

No build step. Edit `index.html` directly and open it in a browser.

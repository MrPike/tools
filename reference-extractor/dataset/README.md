# reference-extractor dataset

Synthetic dataset generation pipeline for the `reference-extractor` browser
tool. Renders a fixed set of 24 fictional CSL-JSON references
(`references.json`) in 10 citation styles with citeproc-js, typesets each
rendered bibliography as the tail of a fake academic paper PDF with pdfkit,
and verifies every PDF's text layer with pdfjs-dist.

## Regenerate

```sh
npm install
node generate.mjs
```

Runs end-to-end from a fresh checkout (the script recreates `pdfs/`,
`expected/`, `rendered/`, `../styles.js` and `../citeproc.js`). Exits
non-zero if any PDF fails verification.

## Layout

- `references.json` — hand-written ground truth: 24 fictional items (journal
  articles with volume/issue/pages/DOI, a book, edited-book chapters,
  conference papers, a PhD thesis, an arXiv preprint, a web page with
  accessed date, an organizational author, a 9-author item, accented author
  names, items with and without DOIs, unique years 1998–2025).
- `styles/` — vendored CSL styles + `locales-en-US.xml`, downloaded from
  github.com/citation-style-language. All are independent styles (no
  `independent-parent`). **Renames upstream:** the requested
  `chicago-fullnote-bibliography.csl`, `vancouver.csl` and
  `vancouver-superscript.csl` were renamed in the styles repository; we
  vendor the current successors under the requested file names:
  - `chicago-fullnote-bibliography.csl` ← `chicago-notes-bibliography.csl`
  - `vancouver.csl` ← `nlm-citation-sequence.csl`
  - `vancouver-superscript.csl` ← `nlm-citation-sequence-superscript.csl`
- `fonts/` — Tinos TTFs (OFL, metric-compatible with Times New Roman),
  embedded in the PDFs. pdfkit's built-in Times-Roman is WinAnsi-only and
  cannot encode `Ł`/`ł` or the `ﬁ`/`ﬂ` ligature code points this dataset
  needs, so embedded fonts are used throughout.
- `pdfs/<style>.pdf` — clean baseline PDF per style.
- `pdfs/<style>-messy.pdf` — same content with injected imperfections.
- `expected/<style>.csl.json` — ground-truth CSL-JSON array per style
  (identical content to `references.json`, one file per style so tests can
  compare per style).
- `rendered/<style>.txt` — bibliography as plain text, one entry per
  paragraph, all markup stripped.
- `rendered/<style>.annotated.txt` — same, with `<i>` italic markers
  preserved (drives node unit tests of the parser without pdf.js).
- `../styles.js` — generated; embeds the en-US locale + 6 preset styles
  (APA 7, MLA 9, Chicago author-date, Cite Them Right Harvard, Vancouver,
  IEEE) as `window.REX_STYLES` for the in-browser preview.
- `../citeproc.js` — generated; vendored `citeproc_commonjs.js` (citeproc
  npm package, v2.4.x) with a provenance header and a one-line guard around
  the CommonJS export so it loads cleanly as a classic browser script.

## What the messy variants inject

All transforms are programmatic (`applyMessyTransforms` + layout options in
`generate.mjs`):

- **Hanging indents** on every bibliography entry (negative first-line
  indent; 30pt in messy vs 18–24pt in clean).
- **Narrow measure**: bibliography set at 250pt width, so entries wrap
  across many lines.
- **Manual hyphenation**: every third entry gets a long word split as
  `examina-` / `tion` (literal `-` + newline in the text run).
- **Page breaks mid-entry**: the narrow bibliography spans multiple pages
  and pdfkit splits paragraphs across page boundaries, so entries straddle
  page breaks.
- **Running headers/footers**: `J. Synth. Bibliometr. 12 (2026) 341–358`
  header and `Page N of M` footer on every page after the first.
- **One DOI broken across a line**: the first entry containing a DOI gets
  `-` + newline inserted inside the DOI string.
- **Unicode ligature characters**: `fi` → `ﬁ`, `fl` → `ﬂ` substituted in
  all body and bibliography text before rendering, simulating what pdf.js
  extracts from ligaturing fonts.

Per-style layout notes: `ieee.pdf` (both variants) uses a two-column layout;
`vancouver-superscript.pdf` uses superscript entry numbers (raised baseline,
smaller font). In-text citations in the dummy body text match the style
family: `(Author, Year)` for author-date styles, `[n]` for bracketed numeric
styles, superscript digits for superscript/notes styles.

## Verification

`generate.mjs` finishes by extracting the text layer of every generated PDF
with pdfjs-dist (legacy build) and asserting that the first five words of
every reference title appear in it. Matching is deliberately tolerant —
whitespace-normalised, case/punctuation-insensitive, ligature-folded, with
an additional `-\n` de-hyphenation variant and a fully space-squashed
fallback, and with running headers/footers stripped — because the messy
variants are supposed to break naive matching. Any title that is not
recoverable after this normalisation fails the run (exit code 1).

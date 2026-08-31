# tools

An assortment of handy and purely vibe-coded tools I've made that are probably of absolutely no use to anyone but myself. But just in case ...

**Live site:** <https://tools.pike.im/>

## Layout

Each tool lives in its own subdirectory:

```
<cool-tool>/
├── index.html    # the tool itself (self-contained, runs client-side)
├── README.md     # what it is and how to use it
└── tool.json     # metadata for the index page
```

`tool.json` looks like:

```json
{
  "title": "Cool Tool",
  "description": "One line about what it does.",
  "created": "2026-08-31",
  "tags": ["some", "tags"]
}
```

`title` and `description` are required; `created` and `tags` are optional.

`build.py` also generates `tool.html`, a navigator that wraps each tool in a
frame with a bar for jumping back to the index or switching between tools
(`tool.html?tool=<slug>`). Tools remain usable standalone at `<slug>/`.

## Adding a new tool

1. Create a subdirectory with the three files above.
2. Push to `main`. A GitHub Action regenerates the root `index.html`
   listing page automatically.

To preview the listing locally, run `python3 build.py` (no dependencies)
and open `index.html`.

## Tools

- [citation-counter](citation-counter/) — per-page citation analysis for PDFs
- [reference-extractor](reference-extractor/) — PDF bibliography → CSL-JSON, with styled preview

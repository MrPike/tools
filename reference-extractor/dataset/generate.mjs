#!/usr/bin/env node
/**
 * generate.mjs — dataset generation pipeline for the reference-extractor tool.
 *
 * Renders dataset/references.json with citeproc-js in 10 citation styles,
 * typesets each bibliography as a synthetic academic-paper PDF with pdfkit
 * (clean + "messy" variants), writes ground-truth CSL-JSON and plain-text
 * renderings, regenerates ../styles.js and ../citeproc.js for the browser
 * tool, and finally verifies every PDF with pdfjs-dist.
 *
 * Usage: npm install && node generate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const CSL = require('citeproc');
const PDFDocument = require('pdfkit');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, '..');
const OUT = {
  pdfs: path.join(__dirname, 'pdfs'),
  expected: path.join(__dirname, 'expected'),
  rendered: path.join(__dirname, 'rendered'),
};
for (const d of Object.values(OUT)) fs.mkdirSync(d, { recursive: true });

const FONT_DIR = path.join(__dirname, 'fonts');
// Tinos (OFL, metric-compatible with Times New Roman) is embedded instead of
// pdfkit's built-in Times-Roman, because the WinAnsi-encoded built-ins cannot
// represent characters this dataset needs (Ł, ł, fi/fl ligature code points).
const FONTS = {
  regular: path.join(FONT_DIR, 'Tinos-Regular.ttf'),
  italic: path.join(FONT_DIR, 'Tinos-Italic.ttf'),
  bold: path.join(FONT_DIR, 'Tinos-Bold.ttf'),
  boldItalic: path.join(FONT_DIR, 'Tinos-BoldItalic.ttf'),
};
for (const [k, p] of Object.entries(FONTS)) {
  if (!fs.existsSync(p)) throw new Error(`Missing font ${p} (${k}) — see dataset/README.md`);
}

const references = JSON.parse(fs.readFileSync(path.join(__dirname, 'references.json'), 'utf8'));
const itemsById = Object.fromEntries(references.map((it) => [it.id, it]));
const localeXml = fs.readFileSync(path.join(__dirname, 'styles', 'locales-en-US.xml'), 'utf8');

// ---------------------------------------------------------------------------
// Style registry
// ---------------------------------------------------------------------------
// Note on vendored file names: three requested style ids were renamed upstream
// in citation-style-language/styles. We vendor the current successor content
// under the originally requested file names:
//   chicago-fullnote-bibliography.csl <- chicago-notes-bibliography.csl
//   vancouver.csl                     <- nlm-citation-sequence.csl
//   vancouver-superscript.csl         <- nlm-citation-sequence-superscript.csl
const STYLES = [
  { key: 'apa', label: 'APA 7', heading: 'References', mode: 'author-year' },
  { key: 'modern-language-association', label: 'MLA 9', heading: 'Works Cited', mode: 'mla' },
  { key: 'chicago-author-date', label: 'Chicago (author-date)', heading: 'References', mode: 'author-year' },
  { key: 'chicago-fullnote-bibliography', label: 'Chicago (notes & bibliography)', heading: 'Bibliography', mode: 'notes' },
  { key: 'harvard-cite-them-right', label: 'Harvard (Cite Them Right)', heading: 'Reference list', mode: 'author-year' },
  { key: 'vancouver', label: 'Vancouver (NLM)', heading: 'References', mode: 'bracket' },
  { key: 'vancouver-superscript', label: 'Vancouver (superscript)', heading: 'References', mode: 'superscript', superscriptLabels: true },
  { key: 'ieee', label: 'IEEE', heading: 'References', mode: 'bracket', twoColumn: true },
  { key: 'american-chemical-society', label: 'ACS', heading: 'References', mode: 'superscript' },
  { key: 'nature', label: 'Nature', heading: 'References', mode: 'superscript' },
];

// ---------------------------------------------------------------------------
// citeproc rendering + HTML parsing
// ---------------------------------------------------------------------------
const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY_MAP[g] ?? m;
  });
}

/** Parse a citeproc HTML bibliography entry into {label, runs, plain, annotated}. */
function parseEntry(html) {
  let s = html.trim();
  s = s.replace(/^<div class="csl-entry">/, '').replace(/<\/div>\s*$/, '').trim();

  let label = null;
  const lm = s.match(/^<div class="csl-left-margin">(.*?)<\/div>\s*<div class="csl-right-inline">(.*?)<\/div>\s*$/s);
  if (lm) {
    label = decodeEntities(lm[1].replace(/<[^>]+>/g, '')).trim();
    s = lm[2];
  }

  // runs: walk tags, tracking italic/bold/sup state
  const runs = [];
  let italic = false, bold = false, sup = false, buf = '';
  const flush = () => {
    if (buf) { runs.push({ text: buf, italic, bold, sup }); buf = ''; }
  };
  const parts = s.split(/(<\/?[a-zA-Z][^>]*>)/);
  for (const part of parts) {
    if (!part) continue;
    const tag = part.match(/^<(\/?)([a-zA-Z]+)/);
    if (tag) {
      const [, closing, name] = tag;
      const n = name.toLowerCase();
      if (n === 'i' || n === 'em') { flush(); italic = !closing; }
      else if (n === 'b' || n === 'strong') { flush(); bold = !closing; }
      else if (n === 'sup') { flush(); sup = !closing; }
      // span/div/etc.: ignored, inner text flows through
    } else {
      buf += part;
    }
  }
  flush();
  for (const r of runs) r.text = decodeEntities(r.text).replace(/\s+/g, ' ');

  const bodyPlain = runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
  const plain = (label ? label + ' ' : '') + bodyPlain;

  // annotated: keep <i> markers, strip everything else
  let annotated = '';
  let annItalic = false;
  for (const r of runs) {
    if (r.italic && !annItalic) { annotated += '<i>'; annItalic = true; }
    if (!r.italic && annItalic) { annotated += '</i>'; annItalic = false; }
    annotated += r.text;
  }
  if (annItalic) annotated += '</i>';
  annotated = ((label ? label + ' ' : '') + annotated).replace(/\s+/g, ' ').trim();

  return { label, runs, plain, annotated };
}

function renderBibliography(styleKey) {
  const styleXml = fs.readFileSync(path.join(__dirname, 'styles', `${styleKey}.csl`), 'utf8');
  const sys = {
    retrieveLocale: () => localeXml,
    retrieveItem: (id) => itemsById[id],
  };
  const engine = new CSL.Engine(sys, styleXml);
  engine.updateItems(references.map((it) => it.id));
  const bib = engine.makeBibliography();
  if (!bib[1] || bib[1].length !== references.length) {
    throw new Error(`citeproc returned ${bib[1]?.length} entries for ${styleKey}, expected ${references.length}`);
  }
  return bib[1].map(parseEntry);
}

// ---------------------------------------------------------------------------
// Fake paper body text with style-appropriate in-text citations
// ---------------------------------------------------------------------------
const BODY_SENTENCES = [
  'The measurement of scholarly impact has long depended on the careful parsing of printed bibliographies',
  'Early approaches relied on manual transcription, a process both laborious and prone to systematic error',
  'Subsequent work demonstrated that citation contexts carry substantial rhetorical information about the citing work',
  'A recurring finding is that reference lists exhibit remarkable regularity within a journal but striking diversity across disciplines',
  'Extraction pipelines must therefore tolerate variation in punctuation, ordering, and typographic convention',
  'Several studies have shown that author name disambiguation remains the principal bottleneck in large scale indexing',
  'The problem is compounded by initials, diacritics, and institutional authors that defy naive parsing rules',
  'Optical character recognition introduces further noise, particularly in documents scanned from bound volumes',
  'Typographic ligatures and discretionary hyphens are frequent sources of spurious tokens in extracted text',
  'Cross-column reading order errors account for a significant fraction of failures in two column layouts',
  'Page furniture such as running heads and folios is routinely mistaken for bibliographic content',
  'Robust segmenters exploit whitespace geometry rather than relying on lexical cues alone',
  'Supervised sequence labelling has emerged as the dominant paradigm for reference string parsing',
  'Feature based models remain competitive when training data is scarce or domain shifted',
  'The availability of style aware synthetic corpora has materially improved evaluation practice',
  'Ground truth construction, however, continues to demand painstaking manual verification',
  'Digital object identifiers provide a strong anchor when present, yet coverage is far from uniform',
  'Older literature is disproportionately affected by missing or malformed persistent identifiers',
  'Conference proceedings and theses occupy a grey zone in many citation style definitions',
  'Preprint servers have introduced new conventions that established styles accommodate only awkwardly',
  'The interplay between volume, issue, and pagination fields is a perennial source of ambiguity',
  'Renderer differences between processor implementations further complicate cross platform comparison',
  'Evaluation protocols should therefore report style level metrics rather than a single aggregate score',
  'Error analysis reveals that truncation of long author lists is mishandled by a surprising number of systems',
  'The et alii device in particular interacts badly with naive regular expression approaches',
  'Title casing conventions differ between styles and must be normalised before string comparison',
  'Accented characters survive some extraction pipelines and are silently normalised away by others',
  'A conservative normalisation strategy preserves the grapheme inventory of the source document',
  'Downstream applications such as recommender systems are sensitive to even small error rates',
  'Bibliographic coupling analyses assume near perfect recall of the underlying reference lists',
  'The methods section of this paper details a fully synthetic yet typographically faithful corpus',
  'Each document was typeset programmatically under controlled layout perturbations',
  'Imperfections were injected only where they plausibly arise in real production scanning workflows',
  'The corpus spans author date and numeric citation traditions across ten widely used styles',
  'All items are fictional and any resemblance to real publications is entirely coincidental',
  'We release the corpus together with the generation scripts to encourage replication and extension',
];

function authorYearCite(item) {
  const year = item.issued?.['date-parts']?.[0]?.[0] ?? 'n.d.';
  const a = item.author?.[0];
  if (!a) return `(Anonymous, ${year})`;
  if (a.literal) return `(${a.literal}, ${year})`;
  const n = item.author.length;
  if (n === 1) return `(${a.family}, ${year})`;
  if (n === 2) return `(${a.family} and ${item.author[1].family}, ${year})`;
  return `(${a.family} et al., ${year})`;
}
function mlaCite(item) {
  const a = item.author?.[0];
  if (!a) return '(Anonymous)';
  if (a.literal) return `(${a.literal})`;
  const n = item.author.length;
  if (n === 1) return `(${a.family})`;
  if (n === 2) return `(${a.family} and ${item.author[1].family})`;
  return `(${a.family} et al.)`;
}

/** Build body text as run array with style-appropriate in-text citation markers. */
function buildBodyRuns(style) {
  const runs = [];
  let cited = 0;
  for (let i = 0; i < BODY_SENTENCES.length; i++) {
    let sentence = BODY_SENTENCES[i];
    if (i % 3 === 2 && cited < references.length) {
      const item = references[cited];
      const num = cited + 1;
      switch (style.mode) {
        case 'author-year':
          runs.push({ text: sentence + ' ' });
          runs.push({ text: authorYearCite(item) });
          runs.push({ text: '' });
          sentence = '';
          break;
        case 'mla':
          runs.push({ text: sentence + ' ' });
          runs.push({ text: mlaCite(item) });
          sentence = '';
          break;
        case 'bracket':
          runs.push({ text: sentence + ' ' });
          runs.push({ text: `[${num}]` });
          sentence = '';
          break;
        case 'superscript':
        case 'notes':
          runs.push({ text: sentence });
          runs.push({ text: String(num), sup: true });
          sentence = '';
          break;
      }
      cited++;
      runs.push({ text: (sentence ? '' : '.') + ' ' });
    } else {
      runs.push({ text: sentence + '. ' });
    }
    if (i % 7 === 6) runs.push({ text: '\n' }); // paragraph break
  }
  return runs.filter((r) => r.text);
}

// ---------------------------------------------------------------------------
// Messy-variant text transforms
// ---------------------------------------------------------------------------
const ligaturize = (t) => t.replace(/fi/g, 'ﬁ').replace(/fl/g, 'ﬂ');

/** Insert a manual hyphen line-break inside the first word >= minLen chars. */
function hyphenateOnce(text, minLen = 10) {
  const m = text.match(new RegExp(`[A-Za-z]{${minLen},}`));
  if (!m) return { text, done: false };
  const w = m[0];
  const cut = Math.max(4, Math.floor(w.length * 0.55));
  const hyph = w.slice(0, cut) + '-\n' + w.slice(cut);
  return { text: text.slice(0, m.index) + hyph + text.slice(m.index + w.length), done: true };
}

/** Break a DOI/URL across a line: insert "-\n" inside the first doi.org/... or doi:... string. */
function breakDoi(text) {
  const m = text.match(/(https?:\/\/doi\.org\/|doi:\s*)\S+/i);
  if (!m) return { text, done: false };
  const url = m[0];
  const cut = Math.floor(url.length * 0.6);
  const broken = url.slice(0, cut) + '-\n' + url.slice(cut);
  return { text: text.slice(0, m.index) + broken + text.slice(m.index + url.length), done: true };
}

function applyMessyTransforms(entries, bodyRuns) {
  for (const r of bodyRuns) r.text = ligaturize(r.text);
  let doiBroken = false;
  entries.forEach((e, idx) => {
    for (const r of e.runs) r.text = ligaturize(r.text);
    // manual hyphenation in every third entry
    if (idx % 3 === 1) {
      for (const r of e.runs) {
        if (r.sup) continue;
        const res = hyphenateOnce(r.text);
        if (res.done) { r.text = res.text; break; }
      }
    }
    // one DOI broken across a line (first entry that has one)
    if (!doiBroken) {
      for (const r of e.runs) {
        const res = breakDoi(r.text);
        if (res.done) { r.text = res.text; doiBroken = true; break; }
      }
    }
  });
  return { doiBroken };
}

// ---------------------------------------------------------------------------
// PDF drawing
// ---------------------------------------------------------------------------
function fontFor(run) {
  if (run.bold && run.italic) return 'boldItalic';
  if (run.bold) return 'bold';
  if (run.italic) return 'italic';
  return 'regular';
}

/**
 * Draw a sequence of runs as one wrapped paragraph.
 * opts: x, width, indent (negative => hanging indent), fontSize, lineGap,
 *       columns, columnGap, height, align, continuedBefore/after unused.
 */
function drawRuns(doc, runs, opts) {
  const base = {
    width: opts.width,
    indent: opts.indent ?? 0,
    lineGap: opts.lineGap ?? 1.5,
    align: opts.align ?? 'left',
  };
  if (opts.columns) { base.columns = opts.columns; base.columnGap = opts.columnGap; }
  if (opts.height) base.height = opts.height;

  const segs = runs.filter((r) => r.text.length > 0);
  segs.forEach((r, i) => {
    const last = i === segs.length - 1;
    doc.font(FONTS[fontFor(r)]);
    // Always (re)assert the paragraph font size: preceding absolutely-placed
    // labels (e.g. superscript entry numbers) may have left the document at a
    // smaller size, which would leak into this text.
    doc.fontSize(opts.fontSize ?? 10);
    if (r.sup) {
      const y = doc.y;
      doc.fontSize(Math.max(6, (opts.fontSize ?? 10) * 0.7));
      doc.y = y - 3;
      doc.text(r.text, { ...(i === 0 ? base : {}), continued: !last });
      doc.y = y;
      doc.fontSize(opts.fontSize ?? 10);
    } else {
      doc.text(r.text, { ...(i === 0 ? base : {}), continued: !last });
    }
  });
}

async function writePdf(style, rawEntries, { messy }) {
  // deep-ish copy so transforms never touch the clean data
  const entries = rawEntries.map((e) => ({ ...e, runs: e.runs.map((r) => ({ ...r })) }));
  const bodyRuns = buildBodyRuns(style).map((r) => ({ ...r }));
  let messyInfo = {};
  if (messy) messyInfo = applyMessyTransforms(entries, bodyRuns);

  const pdfPath = path.join(OUT.pdfs, `${style.key}${messy ? '-messy' : ''}.pdf`);
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    bufferPages: true,
    autoFirstPage: true,
    info: { Title: `Synthetic paper — ${style.label} bibliography${messy ? ' (messy)' : ''}` },
  });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  const pageW = doc.page.width;
  const contentW = pageW - doc.page.margins.left - doc.page.margins.right;
  const fontSize = 10;
  doc.fontSize(fontSize);

  // --- paper header ---
  doc.font(FONTS.bold).fontSize(15)
    .text('Synthetic Citation Practices in Automated Bibliography Extraction', { align: 'center' });
  doc.moveDown(0.3);
  doc.font(FONTS.regular).fontSize(10)
    .text('M. A. Datapoint, R. K. Groundtruth, and T. Weierstrass', { align: 'center' });
  doc.font(FONTS.italic).fontSize(9)
    .text('Institute of Synthetic Bibliometrics, University of Nowhere', { align: 'center' });
  doc.moveDown(0.8);
  doc.fontSize(fontSize);

  // --- body (~1 page) ---
  const bodyOpts = {
    x: doc.page.margins.left,
    width: contentW,
    fontSize,
    align: 'justify',
  };
  if (style.twoColumn) {
    bodyOpts.columns = 2;
    bodyOpts.columnGap = 18;
    bodyOpts.height = doc.page.height - doc.y - doc.page.margins.bottom;
  }
  doc.x = doc.page.margins.left;
  drawRuns(doc, bodyRuns, bodyOpts);
  doc.moveDown(1.2);

  // Messy two-column variant: pdfkit's column wrapper leaves the cursor
  // mid-column, and the narrow bibliography then interleaves with the body
  // column in pdf.js's text layer. Start the references on a fresh page
  // (a hard column break), keeping the two-column body layout otherwise.
  if (messy && style.twoColumn) doc.addPage();

  // --- bibliography heading ---
  doc.font(FONTS.bold).fontSize(12).text(style.heading, {
    width: style.twoColumn ? contentW : (messy ? 260 : contentW),
  });
  doc.moveDown(0.5);
  doc.fontSize(fontSize);

  // --- bibliography entries ---
  const bibWidth = messy ? 250 : contentW;
  const hang = style.label != null || style.key === 'vancouver-superscript' ? (messy ? 30 : 24) : (messy ? 30 : 18);

  for (const e of entries) {
    const hasLabel = e.label != null;
    const x = doc.page.margins.left;
    const y0 = doc.y;

    if (style.superscriptLabels && hasLabel) {
      // Superscript entry numbers: raised baseline, smaller size — but contained to the label.
      // Draw the label first: it is placed at an absolute y, and pdfkit's _initOptions rewinds doc.y to the
      // explicit y argument, so doc.y must be restored afterwards. Drawing the
      // label before the entry text (rather than after) guarantees a
      // mid-entry page break cannot leave the label — or the cursor — on
      // the wrong page.
      doc.font(FONTS.regular).fontSize(7)
        .text(e.label.replace(/\.$/, ''), x, y0 - 2.5, { lineBreak: false });
      doc.fontSize(fontSize);
      doc.y = y0;
      const entryRuns = e.runs;
      drawRuns(doc, entryRuns, {
        x: x + hang, width: bibWidth - hang, fontSize,
        ...(style.twoColumn ? { columns: 2, columnGap: 18 } : {}),
      });
    } else if (hasLabel) {
      // numeric label inline as first run, hanging indent aligns wrapped lines
      const entryRuns = [{ text: e.label + ' ' }, ...e.runs];
      drawRuns(doc, entryRuns, {
        x: x + hang, width: bibWidth - hang, indent: -hang, fontSize,
        ...(style.twoColumn ? { columns: 2, columnGap: 18 } : {}),
      });
    } else {
      // author-date styles: hanging indent (first line flush left)
      drawRuns(doc, e.runs, {
        x: x + hang, width: bibWidth - hang, indent: -hang, fontSize,
        ...(style.twoColumn ? { columns: 2, columnGap: 18 } : {}),
      });
    }
    doc.moveDown(messy ? 0.25 : 0.4);
  }

  // --- messy: running headers/footers with page numbers on all but page 1 ---
  if (messy) {
    const range = doc.bufferedPageRange();
    for (let p = range.start + 1; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      doc.font(FONTS.regular).fontSize(8);
      doc.text('J. Synth. Bibliometr. 12 (2026) 341–358', doc.page.margins.left, 24, {
        width: contentW, align: 'right', lineBreak: false,
      });
      doc.text(`Page ${p - range.start + 1} of ${range.count}`, doc.page.margins.left,
        doc.page.height - 36, { width: contentW, align: 'center', lineBreak: false });
    }
    doc.switchToPage(range.start + range.count - 1);
  }

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
  return { pdfPath, messyInfo };
}

// ---------------------------------------------------------------------------
// Verification (pdfjs-dist)
// ---------------------------------------------------------------------------
const LIGATURE_FOLD = { ﬀ: 'ff', ﬁ: 'fi', ﬂ: 'fl', ﬃ: 'ffi', ﬄ: 'ffl', ﬅ: 'st', ﬆ: 'st' };
function foldLigatures(s) {
  return s.replace(/[ﬀﬁﬂﬃﬄﬅﬆ]/g, (c) => LIGATURE_FOLD[c] ?? c);
}
function normalizeForMatch(s, { dehyphenate = false } = {}) {
  let t = foldLigatures(s);
  if (dehyphenate) t = t.replace(/-\s+/g, ''); // join words split as "examina-\ntion"
  t = t.toLowerCase();
  t = t.replace(/[^\p{L}\p{N}\s]+/gu, ''); // drop punctuation (quotes, dots, hyphens)
  return t.replace(/\s+/g, ' ').trim();
}

async function extractPdfText(pdfPath) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({
    data, isEvalSupported: false, disableFontFace: true, verbosity: 0,
  }).promise;
  let out = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    out += tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('') + '\n';
  }
  await doc.destroy();
  // Strip running page furniture (headers/footers) injected into the messy
  // variants — a real parser discards these before de-hyphenating, so the
  // checker does the same.
  out = out
    .replace(/^J\. Synth\. Bibliometr\..*$/gm, '')
    .replace(/^Page \d+ of \d+$/gm, '');
  return out;
}

async function verifyPdf(style, pdfPath, entries) {
  const raw = await extractPdfText(pdfPath);
  const variants = [
    normalizeForMatch(raw),
    normalizeForMatch(raw, { dehyphenate: true }),
  ];
  const variantsSquashed = variants.map((v) => v.replace(/ /g, ''));
  const failures = [];
  for (const item of references) {
    const probe = normalizeForMatch(item.title.split(/\s+/).slice(0, 5).join(' '));
    const probeSquashed = probe.replace(/ /g, '');
    const ok = variants.some((v) => v.includes(probe)) ||
      variantsSquashed.some((v) => v.includes(probeSquashed));
    if (!ok) failures.push(item.id);
  }
  return { failures, textLen: raw.length };
}

// ---------------------------------------------------------------------------
// Tool-root artifacts: styles.js + citeproc.js
// ---------------------------------------------------------------------------
function writeStylesJs() {
  const presets = [
    ['apa', 'APA 7'],
    ['modern-language-association', 'MLA 9'],
    ['chicago-author-date', 'Chicago 18 (author-date)'],
    ['harvard-cite-them-right', 'Harvard (Cite Them Right)'],
    ['vancouver', 'Vancouver (NLM)'],
    ['ieee', 'IEEE'],
  ];
  const styles = {};
  for (const [key, label] of presets) {
    styles[key] = {
      label,
      csl: fs.readFileSync(path.join(__dirname, 'styles', `${key}.csl`), 'utf8'),
    };
  }
  const payload = { locale: localeXml, styles };
  const out =
`// GENERATED FILE — do not edit by hand.
// Generated by dataset/generate.mjs on ${new Date().toISOString().slice(0, 10)}.
// Embeds the CSL en-US locale and the preset citation styles used by the
// reference-extractor in-browser preview. Style sources:
// https://github.com/citation-style-language/styles (see dataset/styles/).
window.REX_STYLES = ${JSON.stringify(payload)};
`;
  fs.writeFileSync(path.join(TOOL_ROOT, 'styles.js'), out);
}

function writeCiteprocJs() {
  const srcPath = require.resolve('citeproc');
  const version = JSON.parse(fs.readFileSync(path.join(path.dirname(srcPath), 'package.json'), 'utf8')).version;
  const src = fs.readFileSync(srcPath, 'utf8');
  const header =
`// Vendored citeproc-js v${version} (file: citeproc_commonjs.js from the npm package "citeproc").
// Source: https://www.npmjs.com/package/citeproc — upstream: https://github.com/Juris-M/citeproc-js
// This build works both as a CommonJS module and as a browser global (window.CSL).
// Vendored by dataset/generate.mjs; re-run that script to update.
// Local patch: the trailing "module.exports = CSL" is wrapped in a
// typeof guard so the script loads without a ReferenceError in browsers
// (the global window.CSL is set by the top-level "var CSL" either way).
`;
  // Guard the bare CommonJS export so the file also loads cleanly as a
  // classic browser script. Byte-for-byte upstream apart from this.
  const patched = src.replace(
    /\nmodule\.exports = CSL\s*$/,
    '\nif (typeof module !== "undefined" && module.exports) { module.exports = CSL; }\n'
  );
  if (patched === src) throw new Error('citeproc_commonjs.js export line not found — patch failed');
  fs.writeFileSync(path.join(TOOL_ROOT, 'citeproc.js'), header + patched);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const results = [];
let anyFailure = false;

for (const style of STYLES) {
  const entries = renderBibliography(style.key);

  // expected ground truth + rendered text
  fs.writeFileSync(
    path.join(OUT.expected, `${style.key}.csl.json`),
    JSON.stringify(references, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(OUT.rendered, `${style.key}.txt`),
    entries.map((e) => e.plain).join('\n\n') + '\n'
  );
  fs.writeFileSync(
    path.join(OUT.rendered, `${style.key}.annotated.txt`),
    entries.map((e) => e.annotated).join('\n\n') + '\n'
  );

  // PDFs
  const clean = await writePdf(style, entries, { messy: false });
  const messy = await writePdf(style, entries, { messy: true });

  // verification
  for (const [variant, info] of [['clean', clean], ['messy', messy]]) {
    const { failures, textLen } = await verifyPdf(style, info.pdfPath, entries);
    const pass = failures.length === 0 && textLen > 500;
    if (!pass) anyFailure = true;
    results.push({ style: style.key, variant, pass, failures, textLen });
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  ${style.key} (${variant})  ` +
      `text=${textLen} chars${failures.length ? `  missing: ${failures.join(', ')}` : ''}` +
      `${variant === 'messy' && info.messyInfo.doiBroken ? '  [doi-break injected]' : ''}`
    );
  }
}

writeStylesJs();
writeCiteprocJs();
console.log('\nWrote ../styles.js and ../citeproc.js');

const passed = results.filter((r) => r.pass).length;
console.log(`\nVerification: ${passed}/${results.length} PDFs passed`);
if (anyFailure) {
  console.error('FAILURES PRESENT — see above.');
  process.exit(1);
}
console.log('All done.');

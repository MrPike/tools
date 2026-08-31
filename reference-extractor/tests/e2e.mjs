/* ===== reference-extractor / tests / e2e.mjs =====
 * node tests/e2e.mjs  (node >= 18; uses dataset/node_modules/pdfjs-dist)
 *
 * End-to-end check on real PDFs: for each of dataset/pdfs/<style>[-messy].pdf
 * extract pages with pdf.js (same line reconstruction as tests/harness.html and
 * index.html), run RefParser.parsePages, and score against
 * dataset/expected/<style>.csl.json using the harness's metric definitions.
 *
 * Exit code: 0 iff all 10 CLEAN PDFs pass (segmentation exact AND
 * author+year >= 90%). Messy variants are reported but do not gate.
 */
import { createRequire } from "module";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DS = join(ROOT, "dataset");

const RefParser = require(join(ROOT, "parser.js"));
const pdfjs = require(join(DS, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.js"));

/* ================= pdf.js page extraction (mirrors harness.html) ================= */

function pageLines(items) {
  const groups = {};
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const y = Math.round(it.transform[5] / 3) * 3;
    (groups[y] = groups[y] || []).push(it);
  }
  const ys = Object.keys(groups).map(Number).sort((a, b) => b - a);
  return ys.map((yy) => {
    const its = groups[yy].sort((a, b) => a.transform[4] - b.transform[4]);
    return {
      text: its.map((o) => o.str).join("").trim(),
      y: yy,
      items: its.map((o) => {
        const r = { str: o.str, x: o.transform[4], width: o.width || 0, height: o.height || 0 };
        if (o.italic === true) r.italic = true;
        return r;
      }),
    };
  });
}

function fontIsItalic(font) {
  if (!font) return undefined;
  const name = font.name || font.loadedName || "";
  if (/italic|oblique/i.test(name)) return true;
  try {
    if (font.cssFontInfo && font.cssFontInfo.italicAngle) return true;
  } catch (e) {}
  return false;
}

function resolveItalics(page, items, cache) {
  for (const it of items) {
    const fn = it.fontName;
    if (!fn) continue;
    if (!(fn in cache)) {
      try {
        cache[fn] = fontIsItalic(page.commonObjs.get(fn));
      } catch (e) {
        cache[fn] = undefined;
      }
    }
    if (cache[fn] === true) it.italic = true;
  }
}

async function extractPages(pdfPath) {
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({
    data, isEvalSupported: false, disableFontFace: true, verbosity: 0,
  }).promise;
  const pages = [];
  const fontCache = {};
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    resolveItalics(page, tc.items, fontCache);
    pages.push({ lines: pageLines(tc.items) });
  }
  await doc.destroy();
  return pages;
}

/* ================= matching & scoring (mirrors harness.html) ================= */

function norm(s, keepSpaces) {
  s = String(s == null ? "" : s).toLowerCase();
  if (s.normalize) s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = keepSpaces
    ? s.replace(/[^a-z0-9]+/g, " ").replace(/^ +| +$/g, "")
    : s.replace(/[^a-z0-9]+/g, "");
  return s;
}

function titleSim(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = {}, tb = {};
  let inter = 0, uni = 0;
  a.split(" ").forEach((w) => { if (w) ta[w] = 1; });
  b.split(" ").forEach((w) => { if (w) tb[w] = 1; });
  for (const t in ta) { uni++; if (tb[t]) inter++; }
  for (const t in tb) { if (!ta[t]) uni++; }
  return uni ? inter / uni : 0;
}

function yearOf(csl) {
  if (!csl || !csl.issued || !csl.issued["date-parts"]) return null;
  const dp = csl.issued["date-parts"][0];
  return dp && dp.length ? dp[0] : null;
}

function matchEntries(refs, expected) {
  const cands = [];
  for (let i = 0; i < refs.length; i++) {
    const py = yearOf(refs[i].csl);
    const pt = norm(refs[i].csl.title, true);
    for (let j = 0; j < expected.length; j++) {
      const ts = titleSim(pt, norm(expected[j].title, true));
      const ye = py != null && py === yearOf(expected[j]) ? 1 : 0;
      if (ye || ts >= 0.6) cands.push({ i, j, s: ye * 2 + ts });
    }
  }
  cands.sort((a, b) => b.s - a.s);
  const usedP = {}, usedE = {}, pairs = [];
  for (const c of cands) {
    if (usedP[c.i] || usedE[c.j]) continue;
    usedP[c.i] = 1; usedE[c.j] = 1;
    pairs.push(c);
  }
  return pairs;
}

function authorOK(pcsl, ecsl) {
  const pa = pcsl.author, ea = ecsl.author;
  if (!ea || !ea.length) return !pa || !pa.length;
  if (!pa || !pa.length) return false;
  const eLit = ea[0] && ea[0].literal, pLit = pa[0] && pa[0].literal;
  if (eLit || pLit) {
    if (!eLit || !pLit) return false;
    const a = norm(eLit), b = norm(pLit);
    return a === b || (!!a && !!b && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0));
  }
  const ef = ea.map((x) => norm(x.family)).filter(Boolean).sort();
  const pf = pa.map((x) => norm(x.family)).filter(Boolean).sort();
  if (ef.length === pf.length && ef.every((v, i) => v === pf[i])) return true;
  // et al. credit: parsed families are a subset of the expected ones with the
  // same FIRST author. Note: the harness compares sorted pf[0]/ef[0], which
  // only holds when the first author also sorts first alphabetically; we
  // compare the actual first authors (the documented intent), otherwise this
  // credit would be unreachable for a perfect parse of "X, et al." entries.
  const ef0 = norm(ea[0] && ea[0].family), pf0 = norm(pa[0] && pa[0].family);
  if (pcsl.author.etal && pf.length && pf0 && pf0 === ef0) {
    return pf.every((v) => ef.indexOf(v) >= 0);
  }
  return false;
}

function normDoi(d) {
  return String(d || "").toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "")
    .replace(/[.,;]+$/, "");
}
function doiOK(pcsl, ecsl) { return normDoi(pcsl.DOI) === normDoi(ecsl.DOI); }

function containerOK(pcsl, ecsl) {
  const p = norm(pcsl["container-title"], true), e = norm(ecsl["container-title"], true);
  if (!p && !e) return true;
  if (!p || !e) return false;
  if (p === e) return true;
  return titleSim(p, e) >= 0.8 || p.indexOf(e) >= 0 || e.indexOf(p) >= 0;
}

function scorePdf(name, result, expected) {
  const refs = result.refs || [];
  const pairs = matchEntries(refs, expected);
  const matchedP = {}, matchedE = {};
  let auth = 0, yr = 0, doi = 0, doiTot = 0, cont = 0, contTot = 0;
  expected.forEach((e) => {
    if (e.DOI) doiTot++;
    if (e["container-title"]) contTot++;
  });
  pairs.forEach((c) => {
    const p = refs[c.i].csl, e = expected[c.j];
    matchedP[c.i] = 1; matchedE[c.j] = 1;
    if (authorOK(p, e)) auth++;
    if (yearOf(p) === yearOf(e)) yr++;
    if (e.DOI && doiOK(p, e)) doi++;
    if (e["container-title"] && containerOK(p, e)) cont++;
  });
  const missed = [], spurious = [];
  expected.forEach((e, j) => {
    if (!matchedE[j]) missed.push({ title: e.title || "(no title)", year: yearOf(e) });
  });
  refs.forEach((r, i) => {
    if (!matchedP[i]) spurious.push({ raw: (r.raw || "").slice(0, 160), issues: r.issues || [] });
  });
  return {
    name, found: refs.length, expected: expected.length, matched: pairs.length,
    auth, yr, doi, doiTot, cont, contTot,
    detected: result.style || "?", sectionFound: result.sectionFound,
    warnings: result.warnings || [], missed, spurious,
  };
}

/* pass = segmentation exact AND author+year >= 90 on average (harness verdict) */
function passes(r) {
  const authP = r.expected ? (100 * r.auth) / r.expected : 0;
  const yrP = r.expected ? (100 * r.yr) / r.expected : 0;
  return r.found === r.expected && (authP + yrP) / 2 >= 90;
}
function ayPct(r) {
  const authP = r.expected ? (100 * r.auth) / r.expected : 0;
  const yrP = r.expected ? (100 * r.yr) / r.expected : 0;
  return (authP + yrP) / 2;
}

/* ================= runner ================= */

const STYLES = [
  "apa", "modern-language-association", "chicago-author-date",
  "chicago-fullnote-bibliography", "harvard-cite-them-right", "vancouver",
  "vancouver-superscript", "ieee", "american-chemical-society", "nature",
];
const PDFS = [];
STYLES.forEach((s) => { PDFS.push(s); PDFS.push(s + "-messy"); });

const expectedCache = {};
function loadExpected(style) {
  if (!expectedCache[style]) {
    expectedCache[style] = JSON.parse(
      readFileSync(join(DS, "expected", style + ".csl.json"), "utf8"));
  }
  return expectedCache[style];
}

function pad(s, n) { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); }
function pctText(x, n) { return n ? `${x}/${n} (${Math.round((100 * x) / n)}%)` : "—"; }

function printTable(rows, title) {
  console.log(`\n=== ${title} ===`);
  console.log(
    pad("PDF", 34) + pad("found/exp", 10) + pad("matched", 8) +
    pad("authors", 15) + pad("year", 15) + pad("DOI", 12) +
    pad("container", 14) + pad("detected", 22) + "verdict");
  const t = { found: 0, expected: 0, matched: 0, auth: 0, yr: 0, doi: 0, doiTot: 0, cont: 0, contTot: 0 };
  for (const r of rows) {
    ["found", "expected", "matched", "auth", "yr", "doi", "doiTot", "cont", "contTot"]
      .forEach((k) => { t[k] += r[k]; });
    console.log(
      pad(r.name, 34) +
      pad(`${r.found}/${r.expected}`, 10) +
      pad(r.matched, 8) +
      pad(pctText(r.auth, r.expected), 15) +
      pad(pctText(r.yr, r.expected), 15) +
      pad(pctText(r.doi, r.doiTot), 12) +
      pad(pctText(r.cont, r.contTot), 14) +
      pad(r.detected + (r.sectionFound ? "" : " (no section)"), 22) +
      (r.error ? "ERROR" : passes(r) ? "pass" : "FAIL"));
  }
  console.log(
    pad(`totals (${rows.length} PDFs)`, 34) +
    pad(`${t.found}/${t.expected}`, 10) +
    pad(t.matched, 8) +
    pad(pctText(t.auth, t.expected), 15) +
    pad(pctText(t.yr, t.expected), 15) +
    pad(pctText(t.doi, t.doiTot), 12) +
    pad(pctText(t.cont, t.contTot), 14));
  return t;
}

async function runOne(name) {
  const pdfPath = join(DS, "pdfs", name + ".pdf");
  const pages = await extractPages(pdfPath);
  const result = RefParser.parsePages(pages, {});
  const style = name.replace(/-messy$/, "");
  return scorePdf(name, result, loadExpected(style));
}

async function main() {
  const cleanRows = [], messyRows = [];
  const verbose = process.argv.includes("-v");
  for (const name of PDFS) {
    let scored;
    try {
      scored = await runOne(name);
    } catch (err) {
      scored = {
        name, found: 0, expected: 24, matched: 0, auth: 0, yr: 0,
        doi: 0, doiTot: 1, cont: 0, contTot: 1,
        detected: "error", sectionFound: false,
        warnings: [String(err && err.message ? err.message : err)],
        missed: [], spurious: [], error: true,
      };
    }
    (/-messy$/.test(name) ? messyRows : cleanRows).push(scored);
    console.log(
      `${name}: found ${scored.found}/${scored.expected}, matched ${scored.matched}, ` +
      `auth ${scored.auth}, year ${scored.yr}, a+y ${Math.round(ayPct(scored))}%`);
    if (verbose) {
      scored.missed.forEach((m) => console.log(`   missed: ${m.title} (${m.year})`));
      scored.spurious.forEach((s) => console.log(`   spurious: ${s.raw}`));
      scored.warnings.forEach((w) => console.log(`   warning: ${w}`));
    }
  }

  printTable(cleanRows, "CLEAN PDFs");
  printTable(messyRows, "MESSY PDFs (reported, not gated)");

  // regressions vs clean
  console.log("\n=== messy vs clean deltas (author+year %) ===");
  for (const s of STYLES) {
    const c = cleanRows.find((r) => r.name === s);
    const m = messyRows.find((r) => r.name === s + "-messy");
    if (c && m) {
      const d = Math.round(ayPct(m) - ayPct(c));
      console.log(`${pad(s, 34)} clean ${Math.round(ayPct(c))}%  messy ${Math.round(ayPct(m))}%  delta ${d}%`);
    }
  }

  const cleanFails = cleanRows.filter((r) => !passes(r));
  console.log("\n=== result ===");
  console.log(`clean gate: ${cleanRows.length - cleanFails.length}/${cleanRows.length} pass` +
    (cleanFails.length ? `  failing: ${cleanFails.map((r) => r.name).join(", ")}` : ""));
  process.exit(cleanFails.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });

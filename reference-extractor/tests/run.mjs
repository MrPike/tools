/* ===== reference-extractor / tests / run.mjs =====
 * node tests/run.mjs  (node >= 18, no external deps)
 *
 * For every dataset/rendered/<style>.txt: parseText it, compare against
 * dataset/expected/<style>.csl.json. Score segmentation, author family sets,
 * year exact, DOI exact, container-title fuzzy. Then run edge-case fixtures.
 */
import { createRequire } from "module";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DS = join(ROOT, "dataset");

const RefParser = require(join(ROOT, "parser.js"));
const fn = RefParser.fuzzyNorm || RefParser._internals.fuzzyNorm;
function fz(s) { return fn(s); }

/* ---------- matching / scoring ---------- */

function authorFamilies(authors) {
  if (!authors || !authors.length) return { families: [], literal: null };
  if (authors[0] && authors[0].literal) return { families: [], literal: authors[0].literal };
  return { families: authors.map(a => a.family).filter(Boolean), literal: null };
}

function yearOf(csl) {
  if (!csl.issued || !csl.issued["date-parts"]) return null;
  const dp = csl.issued["date-parts"][0];
  return dp && dp.length ? dp[0] : null;
}

// match a parsed entry to an expected one (by year, fallback fuzzy title)
function matchEntry(parsed, expectedList) {
  const py = yearOf(parsed.csl);
  const ptitle = fz(parsed.csl.title || "");
  if (py != null) {
    for (const e of expectedList) if (yearOf(e) === py) return e;
  }
  let best = null, bestS = -1;
  for (const e of expectedList) {
    const s = ptitle ? titleSim(ptitle, fz(e.title || "")) : 0;
    if (s > bestS) { bestS = s; best = e; }
  }
  return bestS >= 0.6 ? best : null;
}

function titleSim(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  // token overlap (Jaccard)
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function authorOK(parsed, expected) {
  const p = authorFamilies(parsed.csl.author);
  const e = authorFamilies(expected.author);
  const etal = !!(parsed.csl.author && parsed.csl.author.etal);
  // literal / org authors
  if (e.literal || p.literal) {
    if (!p.literal || !e.literal) return false;
    return fz(p.literal) === fz(e.literal) || fz(p.literal).indexOf(fz(e.literal)) >= 0 ||
           fz(e.literal).indexOf(fz(p.literal)) >= 0;
  }
  const pf = p.families.slice().sort();
  const ef = e.families.slice().sort();
  if (pf.length === ef.length && pf.every((v, i) => v === ef[i])) return true;
  if (etal && pf.length && pf[0] === ef[0]) {
    // et al. credit: parsed families must be a prefix/subset of expected
    const ex = new Set(ef);
    return pf.every(v => ex.has(v));
  }
  return false;
}

function yearOK(parsed, expected) {
  return yearOf(parsed.csl) === yearOf(expected);
}

function doiOK(parsed, expected) {
  const p = (parsed.csl.DOI || "").toLowerCase().replace(/[.,;]+$/, "");
  const e = (expected.DOI || "").toLowerCase().replace(/[.,;]+$/, "");
  return p === e;
}

function containerOK(parsed, expected) {
  const p = fz(parsed.csl["container-title"] || "");
  const e = fz(expected["container-title"] || "");
  if (!p && !e) return true;
  if (!p || !e) return false;
  if (p === e) return true;
  return titleSim(p, e) >= 0.8 || p.indexOf(e) >= 0 || e.indexOf(p) >= 0;
}

/* ---------- per-style runner ---------- */

const STYLES = [
  "apa", "modern-language-association", "chicago-author-date",
  "chicago-fullnote-bibliography", "harvard-cite-them-right", "vancouver",
  "vancouver-superscript", "ieee", "american-chemical-society", "nature"
];

function runStyle(style) {
  const txt = readFileSync(join(DS, "rendered", style + ".txt"), "utf8");
  const expected = JSON.parse(readFileSync(join(DS, "expected", style + ".csl.json"), "utf8"));
  const res = RefParser.parseText(txt);
  const refs = res.refs;
  const matched = refs.map(r => matchEntry(r, expected));
  let auth = 0, yr = 0, doi = 0, cont = 0;
  for (let i = 0; i < refs.length; i++) {
    const ex = matched[i];
    if (!ex) continue;
    if (authorOK(refs[i], ex)) auth++;
    if (yearOK(refs[i], ex)) yr++;
    if (doiOK(refs[i], ex)) doi++;
    if (containerOK(refs[i], ex)) cont++;
  }
  return {
    style, detected: res.style, found: refs.length, expected: expected.length,
    matched: matched.filter(Boolean).length,
    auth, yr, doi, cont, warnings: res.warnings
  };
}

/* ---------- edge-case fixtures ---------- */

function assert(cond, msg) {
  if (!cond) throw new Error("EDGE FIXTURE FAILED: " + msg);
}

function runEdgeFixtures() {
  const results = [];

  // 1. hyphenated wrapped entry
  {
    const r = RefParser.parseText(
      "References\n\nSmith, J. (2020). A study of examina-\ntion methods in hydrology. Journal of Examples, 12(3), 45–67.");
    const e = r.refs[0];
    assert(r.refs.length === 1, "hyphen: expected 1 entry, got " + r.refs.length);
    assert((e.csl.title || "").toLowerCase().indexOf("examination") >= 0,
      "hyphen: title should contain 'examination', got " + e.csl.title);
    assert(yearOf(e.csl) === 2020, "hyphen: year 2020, got " + yearOf(e.csl));
    results.push("hyphenated wrapped entry: OK");
  }

  // 2. DOI split across lines
  {
    const r = RefParser.parseText(
      "References\n\nSmith, J. (2020). Title here. Journal of Examples, 12(3), 45–67. https://doi.org/10.1007/s00122-\n0914-6");
    const e = r.refs[0];
    assert(e.csl.DOI === "10.1007/s00122-0914-6",
      "doi-split: DOI should be 10.1007/s00122-0914-6, got " + e.csl.DOI);
    results.push("DOI split across lines: OK (" + e.csl.DOI + ")");
  }

  // 3. header / footer lines to strip
  {
    const r = RefParser.parseText(
      "References\n\nSmith, J. (2020). Title one. Journal A, 1, 1–2.\n\n" +
      "Page 1 of 1\n\nJ. Synth. Bibliometr. 12 (2026) 341–358\n\n" +
      "Jones, K. (2021). Title two. Journal B, 2, 3–4.");
    assert(r.refs.length === 2, "headers: expected 2 entries, got " + r.refs.length);
    const years = r.refs.map(x => yearOf(x.csl)).sort();
    assert(years[0] === 2020 && years[1] === 2021, "headers: years wrong " + years.join(","));
    results.push("header/footer stripping: OK");
  }

  // 4. et al. truncation
  {
    const r = RefParser.parseText(
      "References\n\nSmith, J., Jones, K., et al. (2020). Title. Journal, 1, 1–2.");
    const e = r.refs[0];
    assert(e.csl.author && e.csl.author.length >= 1 && e.csl.author[0].family === "Smith",
      "etal: first author Smith, got " + JSON.stringify(e.csl.author));
    assert(e.issues.some(s => /et al/i.test(s)), "etal: should flag truncation, got " + e.issues.join(";"));
    results.push("et al. truncation: OK");
  }

  // 5. two-author & entry
  {
    const r = RefParser.parseText(
      "References\n\nBrown, L., & White, P. (2019). A nice title. Journal, 4(2), 10–20.");
    const e = r.refs[0];
    const fams = (e.csl.author || []).map(a => a.family).sort();
    assert(fams.join(",") === "Brown,White", "two-auth &: got " + fams.join(","));
    assert(yearOf(e.csl) === 2019, "two-auth: year 2019, got " + yearOf(e.csl));
    results.push("two-author & entry: OK");
  }

  // 6. a book
  {
    const r = RefParser.parseText(
      "References\n\nAlmeida, R. J. (2001). Principles of computational hydrology. 2nd ed. Oxford University Press.");
    const e = r.refs[0];
    assert(e.csl.author && e.csl.author[0].family === "Almeida", "book: author Almeida");
    assert(yearOf(e.csl) === 2001, "book: year 2001");
    assert(!e.csl["container-title"], "book: no container-title, got " + e.csl["container-title"]);
    results.push("book entry: OK (type=" + e.csl.type + ")");
  }

  // 7. an entry with no year (must produce an issue, not crash)
  {
    const r = RefParser.parseText(
      "References\n\nUnknown, U. A title with no year. Journal, 1, 1–2.");
    const e = r.refs[0];
    assert(e.csl.author && e.csl.author[0].family === "Unknown", "no-year: author Unknown");
    assert(!e.csl.issued, "no-year: should have no issued, got " + JSON.stringify(e.csl.issued));
    assert(e.issues.some(s => /year/i.test(s)), "no-year: should flag missing year, got " + e.issues.join(";"));
    results.push("no-year entry: OK (issued=" + JSON.stringify(e.csl.issued) + ")");
  }

  // 8. letter-spaced R E F E R E N C E S heading
  {
    const r = RefParser.parseText(
      "R E F E R E N C E S\n\nSmith, J. (2020). Title. Journal, 1, 1–2.");
    assert(r.sectionFound === true, "letterspaced: sectionFound should be true");
    assert(r.refs.length === 1, "letterspaced: expected 1 entry, got " + r.refs.length);
    assert(yearOf(r.refs[0].csl) === 2020, "letterspaced: year 2020");
    results.push("letter-spaced heading: OK");
  }

  return results;
}

/* ---------- main ---------- */

function pad(s, n) { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); }

function main() {
  const rows = STYLES.map(runStyle);
  console.log("\n=== per-style report ===");
  console.log(pad("style", 34) + pad("found/exp", 12) + pad("matched", 9) +
    pad("auth", 7) + pad("year", 7) + pad("doi", 7) + pad("cont", 7) + "  detected");
  let segAllExact = true;
  let totAuth = 0, totYr = 0, totEntries = 0;
  let totFound = 0, totExpected = 0;
  for (const r of rows) {
    const exp = r.expected;
    if (r.found !== exp) segAllExact = false;
    console.log(
      pad(r.style, 34) +
      pad(r.found + "/" + exp, 12) +
      pad(r.matched, 9) +
      pad(r.auth + "/" + exp, 7) +
      pad(r.yr + "/" + exp, 7) +
      pad(r.doi + "/" + exp, 7) +
      pad(r.cont + "/" + exp, 7) +
      "  " + r.detected
    );
    totAuth += r.auth; totYr += r.yr; totEntries += exp;
    totFound += r.found; totExpected += totExpected;
  }
  const authAcc = totAuth / totEntries;
  const yrAcc = totYr / totEntries;
  const combined = (totAuth + totYr) / (2 * totEntries);
  console.log("\n=== totals ===");
  console.log("segmentation exact for all 10 styles: " + (segAllExact ? "YES" : "NO"));
  console.log("author-family accuracy:  " + (Math.round(authAcc * 1000) / 10) + "%  (" + totAuth + "/" + totEntries + ")");
  console.log("year accuracy:          " + (Math.round(yrAcc * 1000) / 10) + "%  (" + totYr + "/" + totEntries + ")");
  console.log("author+year combined:    " + (Math.round(combined * 1000) / 10) + "%");

  console.log("\n=== edge-case fixtures ===");
  let edgeOK = true;
  try {
    const er = runEdgeFixtures();
    er.forEach(l => console.log("  " + l));
  } catch (err) {
    edgeOK = false;
    console.log("  " + err.message);
  }

  const pass = segAllExact && combined >= 0.90 && edgeOK;
  console.log("\n=== result ===");
  console.log("exit code: " + (pass ? 0 : 1) +
    (segAllExact ? "" : "  [segmentation not exact]") +
    (combined >= 0.90 ? "" : "  [author+year < 90%]") +
    (edgeOK ? "" : "  [edge fixtures failed]"));
  process.exit(pass ? 0 : 1);
}

main();

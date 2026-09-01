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

  // 9. ACM-format entries: given-first authors, ". YYYY. " year marker,
  //    unquoted titles, [n] brackets. Covers journal+DOI, book (Vol.),
  //    chapter (In Proceedings), org author, and et al.
  {
    const acmText = "References\n\n" +
      "[1] Kumaripaba Athukorala, Dorota Głowacka, Giulio Jacucci, Antti Oulasvirta, and Jilles Vreeken. 2016. Is exploratory search different? A comparison of information search behavior for exploratory and lookup tasks. Journal of the Association for Information Science and Technology 67, 11 (2016), 2635–2651. https://doi.org/10.1002/asi.20103\n\n" +
      "[2] Virgil L Anderson and Robert A McLean. 1974. Design of experiments: a realistic approach. Vol. 5. CRC Press.\n\n" +
      "[3] Ingmar Weber and Carlos Castillo. 2010. The demographics of web search. In Proceedings of the 33rd international ACM SIGIR conference on Research and development in information retrieval. 523–530.\n\n" +
      "[4] Google. 2026. Personalization and Google Search results. https://support.google.com/websearch/answer/12410098\n\n" +
      "[5] Diane Kelly et al. 2009. Methods for evaluating interactive information retrieval systems with users. Foundations and Trends in Information Retrieval 3, 1–2 (2009), 1–224.";
    const r = RefParser.parseText(acmText);
    assert(r.style === "numbered (ACM)", "acm: style detected, got " + r.style);
    assert(r.refs.length === 5, "acm: 5 entries, got " + r.refs.length);
    const e1 = r.refs[0];
    assert(e1.csl.author && e1.csl.author.length === 5 &&
      e1.csl.author[0].family === "Athukorala" && e1.csl.author[4].family === "Vreeken",
      "acm[1]: 5 authors Athukorala..Vreeken, got " + JSON.stringify(e1.csl.author));
    assert(yearOf(e1.csl) === 2016, "acm[1]: year 2016, got " + yearOf(e1.csl));
    assert((e1.csl.title || "").indexOf("Is exploratory search different") === 0,
      "acm[1]: title, got " + e1.csl.title);
    assert(e1.csl.DOI === "10.1002/asi.20103", "acm[1]: DOI, got " + e1.csl.DOI);
    assert(e1.csl.volume === "67" && e1.csl.issue === "11" && e1.csl.page === "2635-2651",
      "acm[1]: vol/issue/pages, got " + e1.csl.volume + "/" + e1.csl.issue + "/" + e1.csl.page);
    const e2 = r.refs[1];
    assert(e2.csl.author.length === 2 && e2.csl.author[0].family === "Anderson" &&
      e2.csl.author[1].family === "McLean", "acm[2]: 2 authors Anderson/McLean, got " + JSON.stringify(e2.csl.author));
    assert(yearOf(e2.csl) === 1974, "acm[2]: year 1974, got " + yearOf(e2.csl));
    assert((e2.csl.title || "").toLowerCase().indexOf("design of experiments") === 0,
      "acm[2]: title, got " + e2.csl.title);
    assert(e2.csl.volume === "5" && e2.csl.publisher === "CRC Press" && e2.csl.type === "book",
      "acm[2]: book vol/publisher/type, got " + e2.csl.volume + "/" + e2.csl.publisher + "/" + e2.csl.type);
    const e3 = r.refs[2];
    assert(e3.csl.author.length === 2 && e3.csl.author[1].family === "Castillo",
      "acm[3]: 2 authors ..Castillo, got " + JSON.stringify(e3.csl.author));
    assert(e3.csl.type === "paper-conference", "acm[3]: type paper-conference, got " + e3.csl.type);
    assert((e3.csl["container-title"] || "").indexOf("Proceedings of") === 0,
      "acm[3]: container, got " + e3.csl["container-title"]);
    assert(e3.csl.page === "523-530", "acm[3]: pages, got " + e3.csl.page);
    const e4 = r.refs[3];
    assert(e4.csl.author && e4.csl.author[0].literal === "Google",
      "acm[4]: org author Google, got " + JSON.stringify(e4.csl.author));
    assert(yearOf(e4.csl) === 2026, "acm[4]: year 2026, got " + yearOf(e4.csl));
    assert(e4.csl.type === "webpage", "acm[4]: type webpage, got " + e4.csl.type);
    assert(e4.csl.URL && e4.csl.URL.indexOf("support.google.com") >= 0,
      "acm[4]: URL, got " + e4.csl.URL);
    const e5 = r.refs[4];
    assert(e5.csl.author && e5.csl.author[0].family === "Kelly",
      "acm[5]: Kelly, got " + JSON.stringify(e5.csl.author));
    assert(e5.issues.some(s => /et al/i.test(s)),
      "acm[5]: et al flagged, got " + e5.issues.join(";"));
    assert(e5.csl.volume === "3" && e5.csl.issue === "1-2",
      "acm[5]: vol/issue, got " + e5.csl.volume + "/" + e5.csl.issue);
    results.push("ACM-format entries: OK (journal+DOI, book Vol., In Proceedings, org, et al.)");
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

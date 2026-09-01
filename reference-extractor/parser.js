/* ===== reference-extractor / parser.js =====
 * Dependency-free, ES5-ish bibliography parser.
 * Loaded via <script src="parser.js"> in the browser (assigns window.RefParser)
 * or via require() in node (module.exports).
 *
 * Pipeline:
 *   0. Normalisation (ligatures, quotes, hyphenation, headers, identifiers)
 *   1. Section location (heading regex)
 *   2. Entry segmentation (parseText: numbered / blank-line blocks;
 *      parsePages: geometry — column ordering, header/footer stripping,
 *      overlap track splitting, numbered markers / superscript labels /
 *      hanging indents, hyphenation re-joins)
 *   3. Per-style field extraction -> CSL-JSON
 *   4. Style label + per-entry confidence
 */
(function (root, factory) {
  var mod = factory();
  if (typeof window !== "undefined") { window.RefParser = mod; }
  else if (typeof module !== "undefined" && module.exports) { module.exports = mod; }
  else { root.RefParser = mod; }
})(typeof self !== "undefined" ? self : this, function () {

  /* ===== small helpers ===== */
  function isStr(v) { return typeof v === "string"; }
  function trim(s) { return s.replace(/^\s+|\s+$/g, ""); }
  function trimRight(s) { return s.replace(/\s+$/g, ""); }
  function escRe(s) { return s.replace(/([.*+?^${}()|[\]\\])/g, "\\$1"); }

  /* ===== 0. Normalisation primitives ===== */

  // Fold ligature code points and normalise smart quotes / NBSP / soft hyphen.
  function foldText(s) {
    return s
      .replace(/\uFB01/g, "fi")   // ﬁ
      .replace(/\uFB02/g, "fl")   // ﬂ
      .replace(/\uFB00/g, "ff")   // ﬀ
      .replace(/\uFB03/g, "ffi")  // ﬃ
      .replace(/\uFB04/g, "ffl") // ﬄ
      .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
      .replace(/[\u00AB\u00BB]/g, '"')
      .replace(/\u00A0/g, " ")    // NBSP
      .replace(/\u202F/g, " ")    // narrow no-break space
      .replace(/\u2007/g, " ")    // figure space
      .replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/g, "") // soft hyphen / ZW chars
      .replace(/[\u2010\u2011]/g, "-") // hyphen variants to ascii hyphen
      .replace(/\u2013/g, "\u2013") // keep en-dash (handled in page extraction)
      .replace(/\u2014/g, "\u2014") // keep em-dash
      .replace(/\u2026/g, "...");
  }

  // Normalise whitespace: collapse runs of spaces (but keep newlines).
  function collapseSpaces(s) {
    return s.replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  }

  // Strip <i> / </i> italic markers; optionally capture italic segments.
  function stripItalicTags(s, capture) {
    var segments = [];
    if (capture) {
      var re = /<i>([\s\S]*?)<\/i>/gi;
      var m;
      while ((m = re.exec(s)) !== null) { if (trim(m[1])) segments.push(trim(m[1])); }
    }
    return { text: s.replace(/<\/?i>/gi, ""), segments: segments };
  }

  // URL or DOI broken across a line without a hyphen: the line ends with an
  // incomplete scheme/host/path fragment ("https://", "...10.1515/", "doi:").
  // Reattach the next line's first token directly (no space).
  function endsWithBrokenUrl(cur) {
    return /(?:https?:\/\/\S*|https?:)[\/:]$/.test(cur) || /https?:$/.test(cur) ||
      /doi:$/i.test(cur);
  }

  // De-hyphenate line-break hyphens within a single block (array of wrapped lines).
  // Word-internal hyphens at a lowercase letter boundary are merged; hyphens that
  // belong to a DOI/URL token are kept (the two fragments are concatenated directly).
  function joinWrappedLines(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var cur = lines[i];
      if (i < lines.length - 1 && endsWithBrokenUrl(cur)) {
        var nx = lines[i + 1];
        var sp = nx.search(/\s/);
        if (sp < 0) { cur = cur + nx; i++; }
        else { cur = cur + nx.slice(0, sp); lines[i + 1] = trim(nx.slice(sp)); }
        out.push(cur);
        continue;
      }
      if (i < lines.length - 1 && cur.length > 1 && cur.charAt(cur.length - 1) === "-") {
        var prevChar = cur.charAt(cur.length - 2);
        var next = lines[i + 1];
        if (/[a-z0-9]/.test(prevChar)) {
          if (/((10\.\d{4,}\/)|(https?:\/\/))/.test(cur)) {
            // keep hyphen, concatenate directly; chain further continuations
            cur = cur + next; i++;
            while (i < lines.length - 1 && cur.charAt(cur.length - 1) === "-") {
              cur = cur + lines[i + 1]; i++;
            }
          } else if (/[a-z]/.test(prevChar) && /^[a-z]/.test(next)) {
            // genuine word break -> merge, drop hyphen
            cur = cur.slice(0, -1) + next; i++;
          } else if (/[a-z]/.test(prevChar) && /^[A-ZÀ-ɏ]/.test(next)) {
            // wrap at a real hyphen in a hyphenated name ("Reyes-" / "García")
            // -> keep the hyphen, join without a space
            cur = cur + next; i++;
          }
        }
      }
      out.push(cur);
    }
    return out;
  }

  // Collapse stray spaces before punctuation.
  function tidyPunct(s) {
    return s.replace(/\s+([,.;:!?])/g, "$1")
      .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
  }

  /* ===== header / footer stripping (text heuristic) ===== */
  function stripHeaderFooters(text) {
    var lines = text.split("\n");
    var counts = {};
    var l;
    for (var i = 0; i < lines.length; i++) {
      l = trim(lines[i]);
      if (!l) continue;
      counts[l] = (counts[l] || 0) + 1;
    }
    var out = [];
    for (var j = 0; j < lines.length; j++) {
      l = trim(lines[j]);
      if (!l) { out.push(lines[j]); continue; }
      // lone page numbers
      if (/^\d{1,3}$/.test(l)) continue;
      // "Page N of M" footers
      if (/^Page\s+\d+\s+of\s+\d+$/i.test(l)) continue;
      // journal running headers like "J. Synth. Bibliometr. 12 (2026) 341–358"
      if (/^\w[\w. &-]*\.\s*\d{1,3}\s*\(\d{4}\)\s*\d{1,4}\s*[\u2013-]\s*\d{1,4}$/.test(l)) continue;
      // repeated short header lines (>=2 occurrences)
      if (counts[l] >= 2 && l.length < 70) continue;
      out.push(lines[j]);
    }
    return out.join("\n");
  }

  /* ===== identifier extraction (DOI / URL / arXiv / ISBN) ===== */
  function extractIdentifiers(text) {
    var doi = null, url = null, arxiv = null, isbn = null;
    var rest = text;
    // rejoin a DOI broken by a stray space inside the token ("10. 1007/...")
    rest = rest.replace(/\b10\.\s+(\d{4,9}\/)/g, "10.$1");

    // DOI (with optional "doi:" prefix) — extracted first so the bare 10.xxxx
    // token is removed before URL extraction sees a doi.org link.
    var m = rest.match(/\b10\.\d{4,9}\/[^\s"<>]+/);
    if (!m) {
      var m2 = rest.match(/doi:\s*(10\.\d{4,9}\/[^\s"<>]+)/i);
      if (m2) m = [m2[1]];
    }
    if (m) {
      doi = m[0].replace(/[.,;)\]]+$/, "");
      rest = rest.replace(m[0], " ");
    }

    // URL (http/https) — before arxiv so the full arxiv.org URL is captured.
    var u = rest.match(/\bhttps?:\/\/[^\s"<>]+/);
    if (u) {
      url = u[0].replace(/[.,;)\]]+$/, "");
      var axu = url.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})(?:v\d+)?/i);
      if (axu) arxiv = axu[1];
      rest = rest.replace(u[0], " ");
    }

    // arXiv id: bare "arXiv: XXXX.XXXXX" or "XXXX.XXXXX"
    if (!arxiv) {
      var ax2 = rest.match(/\barXiv[:\s]*?(\d{4}\.\d{4,5})(?:v\d+)?\b/);
      if (ax2) { arxiv = ax2[1]; rest = rest.replace(ax2[0], " "); }
    }
    if (!arxiv) {
      var ax3 = rest.match(/\b(\d{4}\.\d{4,5})\b/);
      if (ax3) { arxiv = ax3[1]; rest = rest.replace(ax3[0], " "); }
    }
    // clean any leftover bare arxiv ids so they cannot pollute year extraction
    rest = rest.replace(/\b\d{4}\.\d{4,5}\b/g, " ");

    // ISBN
    var ib = rest.match(/\b97[89]-\d[\d\-]{8,14}\d\b/);
    if (ib) { isbn = ib[0].replace(/^ISBN[:\s]*/i, ""); rest = rest.replace(ib[0], " "); }

    return { doi: doi, url: url, arxiv: arxiv, isbn: isbn, rest: rest };
  }

  // Strip accessed-date / cited phrases so they don't pollute year extraction.
  function stripAccessedPhrases(s) {
    return s
      .replace(/Accessed:?\s*[A-Z][a-z]+\.?\s*\d{1,2},?\s*\d{4}/g, " ")
      .replace(/\(accessed\s+\d{4}-\d{2}-\d{2}\)/gi, " ")
      .replace(/\(Accessed:?\s*[A-Z][a-z]+\.?\s*\d{1,2},?\s*\d{4}\)/g, " ")
      .replace(/\[cited\s+\d{4}[^\]]*\]/g, " ")
      .replace(/\bcited\s+\d{4}\s+[A-Z][a-z]+\s+\d{1,2}/g, " ")
      .replace(/Accessed:?\s*(\d{4})-(\d{2})-(\d{2})/gi, " ");
  }

  /* ===== year extraction (position-aware scoring) ===== */
  function findYear(text) {
    var re = /(?:19|20)\d{2}/g;
    var best = null, m;
    while ((m = re.exec(text)) !== null) {
      var i = m.index, j = i + m[0].length;
      var before = i > 0 ? text.charAt(i - 1) : "";
      var after = j < text.length ? text.charAt(j) : "";
      // reject digits embedded in a longer number
      if (/[0-9]/.test(before) || /[0-9]/.test(after)) continue;
      var score = 0;
      var dashBefore = /[\u2013\u2014-]$/.test(text.slice(0, i));
      var dashAfter = /^[\u2013\u2014-]/.test(text.slice(j));
      if (dashBefore || dashAfter) score -= 100;
      if (after === ")") score += 10;
      if (before === "(") score += 5;
      if (after === ";") score += 8;
      if (after === ".") score += 6;
      if (after === ",") score += 5;
      else if (after === " " || after === "") score += 1;
      if (best === null || score > best.score || (score === best.score && i < best.i)) {
        best = { value: parseInt(m[0], 10), i: i, score: score };
      }
    }
    return best;
  }

  /* ===== fuzzy normalisation (for matching) ===== */
  function fuzzyNorm(s) {
    if (!s) return "";
    return s.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ").replace(/^ | $/g, "");
  }

  /* ===== name parsing helpers ===== */
  var INITIAL = "[A-Z\u00C0-\u024F\u0400-\u04FF]\\.?"; // a capital letter with optional period

  // Split a family-first name "Family, Given" -> {family, given}
  function splitFamilyFirst(name) {
    name = trim(name).replace(/[,;]+$/, "");
    var c = name.indexOf(",");
    if (c < 0) return null;
    return { family: trim(name.slice(0, c)), given: trim(name.slice(c + 1)) };
  }

  // Split a given-first name "Given Family" / "Initials Family" -> {family, given}
  function splitGivenFirst(name) {
    name = trim(name).replace(/[,;]+$/, "");
    var parts = name.split(/\s+/);
    if (parts.length < 2) return null;
    var family = parts[parts.length - 1];
    var given = parts.slice(0, parts.length - 1).join(" ");
    return { family: family, given: given };
  }

  // Index of the ". " that ends an author block before a book title. A naive
  // first-". " cut misfires on initials inside the name list ("Lars H.
  // Petersen. The Title."): skip stops that follow a lone capital initial when
  // another period follows within a few words (i.e. the name continues).
  function authorBlockEnd(t) {
    var re = /\.\s+/g, m;
    while ((m = re.exec(t)) !== null) {
      var d = m.index;
      if (/(?:^|\s|,)[A-ZÀ-ɏ]$/.test(t.slice(0, d))) {
        var rest = t.slice(d + m[0].length);
        var nextDot = rest.search(/\./);
        if (nextDot >= 0 && nextDot < 20) continue;
      }
      return d;
    }
    return -1;
  }

  // Detect whether a name block looks like an organisation (no name initials,
  // multi-word, no comma separating family/given).
  function looksLikeOrg(block) {
    var b = trim(block).replace(/[.,;]+$/, "");
    if (!b) return false;
    // name initials like "R." / "S.-J." -> personal
    if (/[A-Z\u00C0-\u024F]\.(?:[-\s]*[A-Z\u00C0-\u024F]\.)*/.test(b)) return false;
    // "Family, Given" pattern -> personal
    if (/^[^,]+,\s+[A-Z]/.test(b)) return false;
    // multi-word capitalised phrase with no initials/comma -> org
    if (/^[A-Z][A-Za-z].*[ ][A-Z]/.test(b) && b.split(/\s+/).length >= 2) return true;
    return false;
  }

  /* ===== author parsers per family ===== */

  // APA / family-first with initials, authors separated by ", " and ", & " / "& ".
  function parseApaAuthors(block) {
    var b = trim(block).replace(/^&\s*/, "");
    var et = b.match(/,\s*et al\.?|\bet al\.?/);
    var etal = false;
    if (et) { etal = true; b = trim(b.slice(0, et.index)); }
    b = b.replace(/\.+$/, "");
    if (looksLikeOrg(b)) return [{ literal: b.replace(/\.+$/, "") }];
    // split at author boundaries: ". ," (period comma) then also "& "
    var rawParts = b.split(/\.\s*,\s*/);
    var authors = [];
    for (var i = 0; i < rawParts.length; i++) {
      var part = trim(rawParts[i]);
      if (!part) continue;
      // the part may contain "& Name, I." for the last author
      var sub = part.split(/\s*,?\s*&\s*/);
      for (var k = 0; k < sub.length; k++) {
        var s = trim(sub[k]);
        if (!s) continue;
        var nm = splitFamilyFirst(s);
        if (nm) authors.push(nm); else authors.push({ literal: s });
      }
    }
    if (etal) authors.etal = true;
    return authors;
  }

  // Harvard: family-first, initials WITHOUT internal spaces ("R.J."), authors
  // separated by ". ," (period comma) and " and ". Handles "et al."
  function parseHarvardAuthors(block) {
    var b = trim(block).replace(/^&\s*/, "");
    var et = b.match(/,\s*et al\.?|\bet al\.?/);
    var etal = false;
    if (et) { etal = true; b = trim(b.slice(0, et.index)); }
    b = b.replace(/\.+$/, "");
    if (looksLikeOrg(b)) return [{ literal: b.replace(/\.+$/, "") }];
    var rawParts = b.split(/\.\s*,\s*/);
    var authors = [];
    for (var i = 0; i < rawParts.length; i++) {
      var part = trim(rawParts[i]);
      if (!part) continue;
      var sub = part.split(/\s*,?\s*and\s*/);
      for (var k = 0; k < sub.length; k++) {
        var s = trim(sub[k]).replace(/^&\s*/, "");
        if (!s) continue;
        var nm = splitFamilyFirst(s);
        if (nm) authors.push(nm); else authors.push({ literal: s });
      }
    }
    if (etal) authors.etal = true;
    return authors;
  }

  // Chicago / MLA: first author family-first "Family, Given", rest given-first
  // "Given Family", separated by ", " and ", and ". Handles "et al."
  function parseChicagoAuthors(block) {
    var b = trim(block).replace(/\.+$/, "");
    var etal = false;
    var et = b.match(/,\s*et al\.?/);
    if (et) { etal = true; b = b.slice(0, et.index); }
    if (looksLikeOrg(b)) return [{ literal: b.replace(/\.+$/, "") }].concat(etal ? [] : []).map(function (a) { return a; });
    var authors = [];
    // split off trailing "and X" authors
    var andParts = b.split(/,\s*and\s+|,?\s+and\s+/);
    // first chunk may itself contain "Family, Given, Given Family, Given Family"
    var head = andParts[0];
    var tail = andParts.slice(1);
    // first author = "Family, Given"
    var first = head.match(/^([^,]+),\s+(.+?)(?:,\s*|$)/);
    if (first) {
      authors.push({ family: trim(first[1]), given: trim(first[2]) });
      var remainder = head.slice(first[0].length);
      // remainder: "Given Family, Given Family" given-first, comma separated
      var rest = remainder.split(/,\s*/);
      for (var i = 0; i < rest.length; i++) {
        var r = trim(rest[i]);
        if (!r) continue;
        var nm = splitGivenFirst(r);
        if (nm) authors.push(nm);
      }
    } else {
      // no comma -> single given-first or org
      if (head && looksLikeOrg(head)) authors.push({ literal: head });
      else if (head) { var nm2 = splitGivenFirst(head); if (nm2) authors.push(nm2); }
    }
    for (var t = 0; t < tail.length; t++) {
      var tn = trim(tail[t]).replace(/^and\s+/, "");
      if (!tn) continue;
      // tail authors are given-first "Given Family"; orgs only ever appear as
      // sole (head) authors, so do not run looksLikeOrg here.
      var nm3 = splitGivenFirst(tn);
      if (nm3) authors.push(nm3); else authors.push({ literal: tn });
    }
    if (etal) authors.etal = true;
    return authors;
  }

  // ACS: family-first "Family, I. I.", "; " separator, no et al.
  function parseAcsAuthors(block) {
    var parts = block.split(/\s*;\s*/);
    var authors = [];
    var i = 0;
    // consume pure "Family, I. I." parts; the author list ends at the first
    // part that is not a bare name (editors, publishers, and years that follow
    // the title must not be mistaken for authors)
    var pureName = /^[^,;]+,\s+[A-ZÀ-ɏ]\.(?:[-\s]*[A-ZÀ-ɏ]\.)*$/;
    for (; i < parts.length - 1; i++) {
      var s = trim(parts[i]);
      if (!pureName.test(s)) break;
      var nm = splitFamilyFirst(s);
      if (nm) authors.push(nm);
    }
    // remaining text starts with the last author: "Family, Initials Title..."
    var last = trim(parts.slice(i).join("; "));
    if (!last) return { authors: authors, titleAndRest: "" };
    if (i === 0) {
      // no "; "-separated list found: single author or organisation. Cut the
      // name at the end of the author block so the title cannot leak into a
      // literal (org) author.
      var cut = authorBlockEnd(last);
      var head = cut >= 0 ? trim(last.slice(0, cut)) : last;
      if (looksLikeOrg(head)) {
        authors.push({ literal: head.replace(/\.+$/, "") });
        return { authors: authors, titleAndRest: cut >= 0 ? trim(last.slice(cut + 2)) : "" };
      }
    }
    var lm = last.match(/^([^,]+),\s+([A-ZÀ-ɏ]\.(?:[-\s]*[A-ZÀ-ɏ]\.)*)\s+(.*)$/);
    if (lm) {
      authors.push({ family: trim(lm[1]), given: trim(lm[2]) });
      return { authors: authors, titleAndRest: trim(lm[3]) };
    }
    // fallback: treat whole last as a name
    if (i === 0) {
      var nm = splitFamilyFirst(last);
      if (nm) authors.push(nm);
      return { authors: authors, titleAndRest: "" };
    }
    return { authors: authors, titleAndRest: last };
  }

  // Vancouver / superscript: family-first "Family AB" (initials fused, no periods),
  // comma separated, "et al." supported.
  function parseVancouverAuthors(block) {
    var b = trim(block).replace(/\.+$/, "");
    var etal = false;
    var et = b.match(/,\s*et al\.?/);
    if (et) { etal = true; b = b.slice(0, et.index); }
    if (!/,/.test(b)) {
      // single token: personal if last token looks like initials, else org
      var toks = b.split(/\s+/);
      var lastTok = toks[toks.length - 1];
      if (/^[A-Z\u00C0-\u024F]{1,3}$/.test(lastTok) && toks.length >= 2) {
        var a = { family: toks[0], given: toks.slice(1).join(" ") };
        var arr = [a]; if (etal) arr.etal = true; return arr;
      }
      if (looksLikeOrg(b)) { var arr2 = [{ literal: b }]; if (etal) arr2.etal = true; return arr2; }
    }
    var parts = b.split(/,\s*/);
    var authors = [];
    for (var i = 0; i < parts.length; i++) {
      var s = trim(parts[i]);
      if (!s) continue;
      var p = s.split(/\s+/);
      if (p.length < 2) { if (s) authors.push({ family: s }); continue; }
      authors.push({ family: p[0], given: p.slice(1).join(" ") });
    }
    if (etal) authors.etal = true;
    return authors;
  }

  // Nature: "Family, I. I." family-first with comma, "&"/"," separators. Consume
  // leading author tokens; stop at the title. Supports "et al." and org authors.
  function parseNatureAuthors(block) {
    var b = trim(block);
    var etal = false;
    var et = b.match(/\bet al\.?/);
    if (et) { etal = true; b = trim(b.slice(0, et.index)); }
    var s = b;
    var authors = [];
    var re = /^(?:&\s*|and\s*)?([A-Z\u00C0-\u024F][^,(&]{1,40}?),\s+([A-Z]\.(?:[-\s]*[A-Z]\.)*)\s*/;
    var guard = 0;
    while (guard++ < 30) {
      var m = re.exec(s);
      if (!m) break;
      authors.push({ family: trim(m[1]), given: trim(m[2]) });
      s = s.slice(m[0].length);
      var sep = s.match(/^(?:,\s*(?:&|and)?\s*|\s*and\s+|\s*&\s*)/);
      if (sep) s = s.slice(sep[0].length); else break;
    }
    if (authors.length === 0) {
      // org author: leading phrase up to ". "
      var org = b.match(/^([A-Z][^."]{2,80})\.\s/);
      if (org) authors.push({ literal: trim(org[1]) });
      s = b.slice(org ? org[0].length : 0);
    }
    if (etal) authors.etal = true;
    return { authors: authors, rest: trim(s) };
  }

  // IEEE: given-first "I. I. Family", "and"/"," separators, "et al." supported.
  function parseIeeeAuthors(block) {
    var b = trim(block).replace(/[.,;]+$/, "");
    var etal = false;
    var et = b.match(/\bet al\.?/);
    if (et) { etal = true; b = trim(b.slice(0, et.index).replace(/[,;]+$/, "")); }
    if (!/\b[A-Z]\.\b/.test(b) && looksLikeOrg(b)) {
      var arr = [{ literal: b }]; if (etal) arr.etal = true; return arr;
    }
    var parts = b.split(/\s+and\s+|,\s+/);
    var authors = [];
    for (var i = 0; i < parts.length; i++) {
      var s = trim(parts[i]);
      if (!s) continue;
      var nm = splitGivenFirst(s);
      if (nm) authors.push(nm); else authors.push({ literal: s });
    }
    if (etal) authors.etal = true;
    return authors;
  }

  // ACM reference format: given-first ("Given M. Family"), comma-separated,
  // "and" before the last author; "et al." supported. The block passed here is
  // the name list only (the caller cuts at ". YYYY."). Authors are personal
  // given-first names by default; a single-token (or all-caps / org-keyword)
  // block is an organisation / handle literal.
  function parseAcmAuthors(block) {
    var b = trim(block).replace(/\.+$/, "");
    var etal = false;
    var et = b.match(/,\s*et al\.?|\bet al\.?/);
    if (et) { etal = true; b = trim(b.slice(0, et.index)); }
    if (!b) { var e0 = []; if (etal) e0.etal = true; return e0; }
    var SUFFIX = /^(.+?)\s+(Jr\.?|Sr\.?|II|III|IV)$/i;
    var ORGKW = /\b(Inc|Ltd|LLC|Corp|Corporation|Company|Universit[a-z]+|Institute|Association|Academy|Society|Foundation|Organiz|Agency|Department|Ministry|College|Committee|Council|Government|WHO|UNESCO|IEEE|ACM)\b/i;
    function oneName(s) {
      s = trim(s).replace(/[,;]+$/, "").replace(/^and\s+/i, "").replace(/^&\s*/, "");
      if (!s) return null;
      if (!/\s/.test(s)) return { literal: s };                       // single token
      if (ORGKW.test(s) || /^[A-Z][A-Z0-9 &.\-]{3,}$/.test(s)) return { literal: s };
      var suf = s.match(SUFFIX);
      if (suf) {
        var nm = splitGivenFirst(suf[1]);
        if (nm) { nm.family = nm.family + " " + suf[2].replace(/\.$/, ""); return nm; }
      }
      var nm2 = splitGivenFirst(s);
      if (nm2) return nm2;
      return { literal: s };
    }
    // split into author chunks: commas first, then an "and" inside a chunk
    var parts = b.split(/\s*,\s*/);
    var authors = [];
    for (var i = 0; i < parts.length; i++) {
      var p = trim(parts[i]).replace(/^and\s+/i, "").replace(/^&\s*/, "");
      if (!p) continue;
      var sub = p.split(/\s+and\s+/i);
      for (var k = 0; k < sub.length; k++) {
        var s = trim(sub[k]);
        if (!s) continue;
        var nm3 = oneName(s);
        if (nm3) authors.push(nm3);
      }
    }
    if (etal) authors.etal = true;
    return authors;
  }

  /* ===== volume / issue / page extraction ===== */
  function parseVolIssuePages(text) {
    var out = {};
    var m;
    // "vol(issue), pages"  e.g. 48(5), 655–84   or  2019(256), 55–79
    m = text.match(/\b(\d{1,4})\s*\(([^)]+)\)\s*,?\s*(?:pp?\.\s*)?(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
    if (m) { out.volume = m[1]; out.issue = m[2]; out.page = m[3] + "-" + m[4]; return out; }
    // "vol(issue):pages"  vancouver  41(2):113–29
    m = text.match(/\b(\d{1,4})\s*\(([^)]+)\)\s*:\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
    if (m) { out.volume = m[1]; out.issue = m[2]; out.page = m[3] + "-" + m[4]; return out; }
    // "vol (issue): pages" chicago  48 (5): 655–84
    m = text.match(/\b(\d{1,4})\s*\(([^)]+)\)\s*:\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
    if (m) { out.volume = m[1]; out.issue = m[2]; out.page = m[3] + "-" + m[4]; return out; }
    // "vol, no. issue, pp. pages" MLA / "vol. X, no. Y, pp. Z"
    m = text.match(/\bvol\.\s*(\d{1,4})\s*,?\s*no\.\s*([0-9\u2013-]+)\s*,?\s*(?:year,)?\s*pp\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/i);
    if (m) { out.volume = m[1]; out.issue = m[2]; out.page = m[3] + "-" + m[4]; return out; }
    // "vol(issue), pages" without page range (single page)
    m = text.match(/\b(\d{1,4})\s*\(([^)]+)\)\s*,?\s*(?:pp?\.\s*)?(\d{1,6})/);
    if (m) { out.volume = m[1]; out.issue = m[2]; out.page = m[3]; return out; }
    // "vol, pages"  e.g. "16, 1187–1203"
    m = text.match(/\b(\d{1,4})\s*,?\s*(?:pp?\.\s*)?(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
    if (m) { out.volume = m[1]; out.page = m[2] + "-" + m[3]; return out; }
    // "vol(issue):pages" already covered; bare "pp. x–y"
    m = text.match(/\bpp?\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/i);
    if (m) { out.page = m[1] + "-" + m[2]; return out; }
    // "p. x" single
    return out;
  }

  /* ===== style detection ===== */
  function detectStyle(blocks) {
    var n = blocks.length;
    var bracket = 0, paren = 0, numbered = 0;
    for (var i = 0; i < n; i++) {
      var b = blocks[i];
      if (/^\s*\[\d+\]/.test(b)) bracket++;
      else if (/^\s*\(\d+\)/.test(b)) paren++;
      else if (/^\s*\d+\.\s/.test(b)) numbered++;
    }
    if (bracket > n / 2) {
      // ACM reference format: given-first authors and a standalone ". YYYY. "
      // year marker right after the name list, with unquoted titles. IEEE uses
      // the same [n] markers but quotes its titles and puts the year at the end,
      // so it never produces the ". YYYY. " author-block marker.
      var acm = 0, quotes = 0;
      for (var a = 0; a < n; a++) {
        if (/\. (?:19|20)\d{2}\. /.test(blocks[a])) acm++;
        if (/["\u201C\u201D]/.test(blocks[a])) quotes++;
      }
      if (acm > n / 2 && quotes <= n / 4) return "acm";
      return "ieee";
    }
    if (paren > n / 2) return "acs";
    if (numbered > n / 2) {
      // vancouver vs nature: vancouver uses "year;vol", nature uses "(year)" & "&"
      var yearSemi = 0, amp = 0, parenYear = 0;
      for (var j = 0; j < n; j++) {
        if (/\d{4};\d/.test(blocks[j])) yearSemi++;
        if (/&/.test(blocks[j])) amp++;
        if (/\(\d{4}\)/.test(blocks[j])) parenYear++;
      }
      if (yearSemi > n / 2) return "vancouver";
      if (parenYear > n / 2 || amp > n / 4) return "nature";
      return "vancouver";
    }
    // no label markers survived (e.g. superscript labels dropped as geometry):
    // "year;vol(issue):pages" punct identifies vancouver before author-year voting
    var vs = 0;
    for (var v = 0; v < n; v++) {
      if (/\d{4}\s*;\s*\d/.test(blocks[v])) vs++;
    }
    if (vs > n / 2) return "vancouver";
    // author-year family: vote across signals
    var sig = { mla: 0, harvard: 0, chicagoAD: 0, chicagoFull: 0, apa: 0 };
    for (var k = 0; k < n; k++) {
      var e = blocks[k];
      if (/\bvol\.\s/.test(e) && /\bno\.\s/.test(e) && /\bpp\.\s/.test(e)) sig.mla++;
      if (/\(\d{4}\)\s*"/.test(e)) sig.harvard++;
      if (/\d{4}\.\s*"/.test(e)) sig.chicagoAD++;
      if (/\(\d{4}\):/.test(e)) sig.chicagoFull++;
      if (/\(\d{4}\)\.\s/.test(e) && !/\(\d{4}\)\s*"/.test(e)) sig.apa++;
    }
    var best = "apa", bestV = sig.apa;
    var order = ["harvard", "chicagoAD", "chicagoFull", "mla", "apa"];
    for (var o = 0; o < order.length; o++) {
      var key = order[o];
      if (sig[key] > bestV) { bestV = sig[key]; best = key; }
    }
    // explicit disambiguation
    if (sig.mla >= n / 2) best = "mla";
    else if (sig.harvard >= n / 2) best = "harvard";
    else if (sig.chicagoAD >= n / 2) best = "chicagoAD";
    else if (sig.chicagoFull >= n / 2) best = "chicagoFull";
    return best;
  }

  var STYLE_LABEL = {
    ieee: "numbered (bracketed)",
    acs: "numbered (parenthesized)",
    acm: "numbered (ACM)",
    vancouver: "numbered",
    nature: "numbered",
    apa: "author-year",
    harvard: "author-year",
    chicagoAD: "author-year",
    chicagoFull: "author-year",
    mla: "author-year"
  };

  /* ===== per-template field extraction =====
   * Each extractor receives the entry text (number prefix already stripped,
   * identifiers NOT yet stripped) and returns { csl, issues, confidence }.
   */

  function stripTrailingDot(s) { return s.replace(/[.,;:]+$/, "").replace(/\s+$/, ""); }

  // Split a "container + vol(issue) pages" tail into container / vip / remainder.
  function splitContainerVIP(tail) {
    // tail like: "Journal of Applied Geophysics 41 (2): 655–84"
    var m = tail.match(/^(.*?)\s+(\d{1,4}\s*(?:\([^)]+\))?\s*:?\s*(?:pp?\.\s*)?\d{1,6}\s*[\u2013-]\s*\d{1,6}|(\d{1,4})\s*\(([^)]+)\)\s*,?\s*(?:pp?\.\s*)?\d{1,6}\s*[\u2013-]\s*\d{1,6})/);
    if (m) {
      var container = trim(m[1]);
      var vip = trim(tail.slice(m[0].length));
      return { container: container, vip: m[0].slice(m[1].length).trim(), rest: vip };
    }
    return { container: trim(tail), vip: "", rest: "" };
  }

  function buildEntry(raw, csl, issues) {
    var conf = 1.0;
    if (!csl.author || csl.author.length === 0) { issues.push("no authors found"); conf -= 0.2; }
    if (!csl.issued) { issues.push("no year found"); conf -= 0.25; }
    if (!csl.title) { issues.push("no title found"); conf -= 0.15; }
    if (csl.type === "article-journal" && !csl["container-title"]) conf -= 0.1;
    if (csl.author && csl.author.etal) issues.push("author list truncated (et al.)");
    if (conf < 0.1) conf = 0.1;
    return {
      csl: csl,
      raw: raw,
      confidence: Math.round(conf * 100) / 100,
      issues: issues
    };
  }

  /* ---- APA ---- */
  function extractApa(text) {
    var issues = [];
    var ids = extractIdentifiers(text);
    var t = stripAccessedPhrases(ids.rest);
    var yr = findYear(t);
    var year = yr ? yr.value : null;
    var yearIndex = yr ? yr.i : -1;
    var csl = { id: null, type: "article-journal" };
    if (year) csl.issued = { "date-parts": [[year]] };
    applyIds(csl, ids);

    var authorBlock = yearIndex >= 0 ? trim(t.slice(0, yearIndex)) : trim(t);
    authorBlock = authorBlock.replace(/\(\s*$/, "").replace(/\.+$/, "");
    csl.author = parseApaAuthors(authorBlock);

    var after = yearIndex >= 0 ? t.slice(yr.i + 4) : t; // skip "(year)"
    after = after.replace(/^\)\s*\.?\s*/, "").replace(/^\s*\.?\s*/, "");
    // title vs container
    // APA: title. then container, vol(issue), pages.
    var title, container, vip;
    // chapter / "In"?
    var inM = after.match(/^(.*?)\.\s*In\s+/);
    // book: no container, ends with publisher
    // find container after a ". " that ends the title
    var m = after.match(/^(.*?)\.\s+([^.]*)\s*,\s*(\d{1,4})\s*\(([^)]+)\)\s*,\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
    if (m) {
      title = m[1]; container = m[2];
      csl.volume = m[3]; csl.issue = m[4]; csl.page = m[5] + "-" + m[6];
    } else {
      // "Container, vol, pages"  e.g. Nature Communications, 16, 1187–1203
      var m2 = after.match(/^(.*?)\.\s+([^,]*?),\s*(\d{1,4})\s*,\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
      if (m2) {
        title = m2[1]; container = m2[2]; csl.volume = m2[3]; csl.page = m2[4] + "-" + m2[5];
      } else {
        // "Proceedings..., pages" conference
        var m3 = after.match(/^(.*?)\.\s+(.*?)\s*,\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
        if (m3) { title = m3[1]; container = m3[2]; csl.page = m3[3] + "-" + m3[4]; }
        else {
          // book / webpage / preprint: title. [edition]. Publisher   or title. Publisher. URL
          var pub = after.match(/^(.*?)\.\s*(?:\(\d+(?:st|nd|rd|th)?\s*ed\.\)\s*\.?\s*)?([^.]+)$/);
          title = after;
        }
      }
    }
    if (title) csl.title = stripTrailingDot(trim(title));
    if (container) csl["container-title"] = stripTrailingDot(trim(container));
    inferApaType(csl, after);
    return buildEntry(text, csl, issues);
  }

  function applyIds(csl, ids) {
    if (ids.doi) csl.DOI = ids.doi;
    if (ids.url) csl.URL = ids.url;
    if (ids.isbn) csl.ISBN = ids.isbn;
    if (ids.arxiv) { csl.archive = "arXiv"; csl.archive_location = ids.arxiv; }
  }

  function inferApaType(csl, after) {
    var low = after.toLowerCase();
    if (/phd thesis/.test(low) || /phd dissertation/.test(low) || /\[phd thesis\]/.test(low)) {
      csl.type = "thesis"; csl.genre = "PhD thesis";
      var inst = after.match(/(.*?)\]\.?\s*([^.]+)$/);
      return;
    }
    if (/arxiv preprint/.test(low)) { csl.type = "article"; }
    if (/^in\s/.test(low) || /\.\s*In\s/.test(after)) {
      if (csl["container-title"]) csl.type = "chapter";
    }
    if (/\bproceedings of\b/.test(low) && !/in\s/.test(low)) {
      if (!csl["container-title"]) {} else csl.type = "paper-conference";
    }
    if (csl.URL && !csl.volume && !csl["container-title"]) csl.type = "webpage";
    if (!csl["container-title"] && !csl.URL && !ids_arxiv(csl)) {
      // book heuristic: has publisher
      if (/University Press|Routledge|Springer|Elgar/.test(after)) csl.type = "book";
    }
  }
  function ids_arxiv(csl) { return csl.archive === "arXiv"; }

  /* ---- Harvard ---- */
  function extractHarvard(text) {
    var issues = [];
    var ids = extractIdentifiers(text);
    var t = stripAccessedPhrases(ids.rest);
    var yr = findYear(t);
    var year = yr ? yr.value : null;
    var csl = { id: null, type: "article-journal" };
    if (year) csl.issued = { "date-parts": [[year]] };
    applyIds(csl, ids);

    // author block = before "(year)"
    var authorBlock = yr ? trim(t.slice(0, yr.i)) : trim(t);
    authorBlock = authorBlock.replace(/\(\s*$/, "").replace(/\.+$/, "");
    csl.author = parseHarvardAuthors(authorBlock);

    var after = yr ? t.slice(yr.i + 4) : t;
    after = after.replace(/^\)\s*/, "").replace(/^\s*\.?\s*/, "");
    // title in quotes, then container, vol(issue), pp.
    var tm = after.match(/^"([^"]+)"\s*,?\s*(.*)$/);
    var title, rest;
    if (tm) { title = tm[1]; rest = tm[2]; }
    else {
      // unquoted (book / thesis / webpage): "Title. Publisher." or "Title. PhD thesis. Inst."
      var bm = after.match(/^(.*?)\.\s+(.*)$/);
      title = bm ? bm[1] : after; rest = bm ? bm[2] : "";
    }
    csl.title = stripTrailingDot(trim(title));
    if (rest) {
      // chapter "in A. X (ed.) Container. Place: Pub, pp."
      var inM = rest.match(/^in\s+(.+?)\.\s+(.*)$/i);
      if (inM) {
        csl.type = "chapter";
        // editors in "A. Goldman and M. Stevenson (eds.) Container"
        var edM = inM[1].match(/^(.*?)\s*\(eds?\.?\)\s*(.*)$/i);
        if (edM) {
          csl.editor = parseIeeeAuthors(edM[1]);
          csl["container-title"] = stripTrailingDot(trim(edM[2]));
        } else {
          csl["container-title"] = stripTrailingDot(trim(inM[1]));
        }
        var tail = inM[2];
        var pubM = tail.match(/^(.+?):\s*(.+?)\s*,\s*pp\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
        if (pubM) { csl["publisher-place"] = trim(pubM[1]); csl.publisher = trim(pubM[2]); csl.page = pubM[3] + "-" + pubM[4]; }
        else { var pp = tail.match(/pp\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/); if (pp) csl.page = pp[1] + "-" + pp[2]; }
      } else {
        // "Container, vol(issue), pp. x–y"
        var cm = rest.match(/^(.+?)\s*,\s*(\d{1,4})\s*\(([^)]+)\)\s*,?\s*pp\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
        if (cm) {
          csl["container-title"] = stripTrailingDot(trim(cm[1]));
          csl.volume = cm[2]; csl.issue = cm[3]; csl.page = cm[4] + "-" + cm[5];
        } else {
          var cm2 = rest.match(/^(.+?)\s*,\s*(\d{1,4})\s*,?\s*pp\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
          if (cm2) { csl["container-title"] = stripTrailingDot(trim(cm2[1])); csl.volume = cm2[2]; csl.page = cm2[3] + "-" + cm2[4]; }
          else {
            // conference proceedings, pp. x–y
            var pc = rest.match(/^(.+?)\s*,\s*pp\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
            if (pc) { csl["container-title"] = stripTrailingDot(trim(pc[1])); csl.page = pc[2] + "-" + pc[3]; csl.type = "paper-conference"; }
            else {
              // book: Place: Publisher
              var bk = rest.match(/^(.+?):\s*(.+)$/);
              if (bk && !/pp\./.test(rest) && !csl.volume) {
                csl["publisher-place"] = trim(bk[1]); csl.publisher = stripTrailingDot(trim(bk[2])); csl.type = "book";
              } else if (/PhD thesis/i.test(rest)) {
                csl.type = "thesis"; csl.genre = "PhD thesis";
                var ti = rest.match(/PhD thesis\.\s*(.+)$/i);
                if (ti) csl.publisher = stripTrailingDot(trim(ti[1]));
              }
            }
          }
        }
      }
    }
    if (/arxiv preprint/i.test(rest || after)) csl.type = "article";
    if (csl.URL && !csl.volume && !csl["container-title"]) csl.type = "webpage";
    return buildEntry(text, csl, issues);
  }

  /* ---- Chicago author-date ---- */
  function extractChicagoAD(text) {
    var issues = [];
    var ids = extractIdentifiers(text);
    var t = stripAccessedPhrases(ids.rest);
    var yr = findYear(t);
    var year = yr ? yr.value : null;
    var csl = { id: null, type: "article-journal" };
    if (year) csl.issued = { "date-parts": [[year]] };
    applyIds(csl, ids);

    // authors before "year."
    var authorBlock = yr ? trim(t.slice(0, yr.i)) : trim(t);
    authorBlock = authorBlock.replace(/\.+$/, "").replace(/\s+$/, "");
    csl.author = parseChicagoAuthors(authorBlock);
    if (csl.author.etal) { csl.author = csl.author.slice(); csl.author.etal = true; }

    var after = yr ? t.slice(yr.i + 4) : t; // after the 4-digit year
    after = after.replace(/^\.\s*/, "").replace(/^\s*/, "");
    // title in quotes
    var tm = after.match(/^"([^"]+)"\.\s*(.*)$/);
    var title, rest;
    if (tm) { title = tm[1]; rest = tm[2]; }
    else { title = after; rest = ""; }
    csl.title = stripTrailingDot(trim(title));
    if (rest) {
      // chapter: "In Container, edited by X. Place: Pub." or articles
      var inM = rest.match(/^In\s+(.+?)\.\s*(.*)$/);
      if (inM) {
        csl.type = "chapter";
        var edM = inM[1].match(/^(.*?),\s*edited by\s+(.+)$/i);
        if (edM) { csl["container-title"] = stripTrailingDot(trim(edM[1])); csl.editor = parseChicagoAuthors(edM[2]); }
        else csl["container-title"] = stripTrailingDot(trim(inM[1]));
        var bk = inM[2].match(/^(.+?)\.\s*$/);
        if (bk) csl.publisher = stripTrailingDot(trim(bk[1]));
      } else {
        // "Container vol (issue): pages"
        var cm = rest.match(/^(.+?)\s+(\d{1,4})\s*\(([^)]+)\)\s*:\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
        if (cm) { csl["container-title"] = stripTrailingDot(trim(cm[1])); csl.volume = cm[2]; csl.issue = cm[3]; csl.page = cm[4] + "-" + cm[5]; }
        else {
          // conference: "Proceedings ... (Place), pages"
          var pc = rest.match(/^(.+?)\s+\(([^)]+)\)\s*,\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
          if (pc) { csl["container-title"] = stripTrailingDot(trim(pc[1])); csl["publisher-place"] = trim(pc[2]); csl.page = pc[3] + "-" + pc[4]; csl.type = "paper-conference"; }
          else { csl["container-title"] = stripTrailingDot(trim(rest)); }
        }
      }
    }
    if (!csl["container-title"] && !csl.URL) {
      // book: title is the whole thing, publisher at end
      if (/University Press|Routledge|Springer|Elgar/.test(rest)) csl.type = "book";
    }
    return buildEntry(text, csl, issues);
  }

  /* ---- Chicago fullnote bibliography ---- */
  function extractChicagoFull(text) {
    var issues = [];
    var ids = extractIdentifiers(text);
    var t = stripAccessedPhrases(ids.rest);
    var yr = findYear(t);
    var year = yr ? yr.value : null;
    var csl = { id: null, type: "article-journal" };
    if (year) csl.issued = { "date-parts": [[year]] };
    applyIds(csl, ids);

    // authors = before the title (quote) or before first ". " for books
    var q = t.indexOf('"');
    var authorBlock;
    if (q >= 0) {
      authorBlock = trim(t.slice(0, q));
    } else {
      // book: "Authors. Title. Place: Pub, year."
      var dp = authorBlockEnd(t);
      authorBlock = dp >= 0 ? trim(t.slice(0, dp)) : trim(t);
    }
    authorBlock = authorBlock.replace(/\.+$/, "");
    csl.author = parseChicagoAuthors(authorBlock);
    if (csl.author.etal) { csl.author = csl.author.slice(); csl.author.etal = true; }

    var after = q >= 0 ? t.slice(q) : (function () {
      var dp2 = authorBlockEnd(t); return dp2 >= 0 ? t.slice(dp2 + 2) : "";
    })();
    var tm = after.match(/^"([^"]+)"\.\s*(.*)$/);
    var title, rest;
    if (tm) { title = tm[1]; rest = tm[2]; }
    else {
      // book: "Title. Place: Publisher, year."
      var bm = after.match(/^(.*?)\.\s+(.+?),\s*\d{4}\.?\s*$/);
      title = bm ? bm[1] : after;
      rest = bm ? bm[2] : "";
      var pubm = rest.match(/^(.+?):\s*(.+)$/);
      if (pubm) { csl["publisher-place"] = trim(pubm[1]); csl.publisher = stripTrailingDot(trim(pubm[2])); }
      if (title) csl.title = stripTrailingDot(trim(title));
      if (!csl["container-title"]) csl.type = "book";
      return buildEntry(text, csl, issues);
    }
    csl.title = stripTrailingDot(trim(title));
    if (rest) {
      var inM = rest.match(/^In\s+(.+?)\.\s*(.*)$/);
      if (inM) {
        csl.type = "chapter";
        var edM = inM[1].match(/^(.*?),\s*edited by\s+(.+)$/i);
        if (edM) { csl["container-title"] = stripTrailingDot(trim(edM[1])); csl.editor = parseChicagoAuthors(edM[2]); }
        else csl["container-title"] = stripTrailingDot(trim(inM[1]));
        if (inM[2]) csl.publisher = stripTrailingDot(trim(inM[2]));
      } else {
        // "Container vol, no. issue (year): pages"  -> year already extracted; rest may still contain (year)
        var cm = rest.match(/^(.+?)\s+(\d{1,4})(?:,\s*nos?\.\s*([0-9\u2013-]+))?\s*(?:\(\d{4}\))?\s*:\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
        if (cm) { csl["container-title"] = stripTrailingDot(trim(cm[1])); csl.volume = cm[2]; if (cm[3]) csl.issue = cm[3]; csl.page = cm[4] + "-" + cm[5]; }
        else {
          var pc = rest.match(/^(.+?)\s+\(([^)]+)\)\s*,\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
          if (pc) { csl["container-title"] = stripTrailingDot(trim(pc[1])); csl["publisher-place"] = trim(pc[2]); csl.page = pc[3] + "-" + pc[4]; csl.type = "paper-conference"; }
          else csl["container-title"] = stripTrailingDot(trim(rest));
        }
      }
    }
    return buildEntry(text, csl, issues);
  }

  /* ---- MLA ---- */
  function extractMla(text) {
    var issues = [];
    var ids = extractIdentifiers(text);
    var t = stripAccessedPhrases(ids.rest);
    var yr = findYear(t);
    var year = yr ? yr.value : null;
    var csl = { id: null, type: "article-journal" };
    if (year) csl.issued = { "date-parts": [[year]] };
    applyIds(csl, ids);

    var q = t.indexOf('"');
    var authorBlock;
    if (q >= 0) authorBlock = trim(t.slice(0, q));
    else {
      var dp = authorBlockEnd(t);
      authorBlock = dp >= 0 ? trim(t.slice(0, dp)) : trim(t);
    }
    authorBlock = authorBlock.replace(/\.+$/, "");
    csl.author = parseChicagoAuthors(authorBlock);
    if (csl.author.etal) { csl.author = csl.author.slice(); csl.author.etal = true; }

    var after = q >= 0 ? t.slice(q) : (function () { var dp2 = authorBlockEnd(t); return dp2 >= 0 ? t.slice(dp2 + 2) : ""; })();
    var tm = after.match(/^"([^"]+)"\.\s*(.*)$/);
    var title, rest;
    if (tm) { title = tm[1]; rest = tm[2]; }
    else {
      // book: "Title. Publisher, year."
      var bm = after.match(/^(.*?)\.\s*(.+?),\s*\d{4}\.?\s*$/);
      title = bm ? bm[1] : after;
      if (bm) csl.publisher = stripTrailingDot(trim(bm[2]));
      if (title) csl.title = stripTrailingDot(trim(title));
      if (!csl["container-title"]) csl.type = "book";
      return buildEntry(text, csl, issues);
    }
    csl.title = stripTrailingDot(trim(title));
    if (rest) {
      // chapter: "Container, edited by X. Publisher, year, pp. x–y"
      var inM = rest.match(/^(.+?),\s*edited by\s+(.+?)\.\s*(.+?),\s*\d{4},\s*pp\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
      if (inM) {
        csl.type = "chapter";
        csl["container-title"] = stripTrailingDot(trim(inM[1]));
        csl.editor = parseChicagoAuthors(inM[2]);
        csl.publisher = stripTrailingDot(trim(inM[3]));
        csl.page = inM[4] + "-" + inM[5];
      } else {
        // "Container, vol. X, no. Y, year, pp. Z"
        var cm = rest.match(/^(.+?),\s*vol\.\s*(\d{1,4})\s*,\s*no\.\s*([0-9\u2013-]+)\s*,\s*\d{4}\s*,\s*pp\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/i);
        if (cm) { csl["container-title"] = stripTrailingDot(trim(cm[1])); csl.volume = cm[2]; csl.issue = cm[3]; csl.page = cm[4] + "-" + cm[5]; }
        else {
          var cm2 = rest.match(/^(.+?),\s*vol\.\s*(\d{1,4})\s*,\s*\d{4}\s*,\s*pp\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/i);
          if (cm2) { csl["container-title"] = stripTrailingDot(trim(cm2[1])); csl.volume = cm2[2]; csl.page = cm2[3] + "-" + cm2[4]; }
          else csl["container-title"] = stripTrailingDot(trim(rest));
        }
      }
    }
    return buildEntry(text, csl, issues);
  }

  /* ---- Vancouver / Vancouver-superscript ---- */
  function extractVancouver(text) {
    var issues = [];
    var ids = extractIdentifiers(text);
    var t = stripAccessedPhrases(ids.rest);
    var yr = findYear(t);
    var year = yr ? yr.value : null;
    var csl = { id: null, type: "article-journal" };
    if (year) csl.issued = { "date-parts": [[year]] };
    applyIds(csl, ids);

    // author block = up to first ". " (names have no periods)
    var dp = t.indexOf(". ");
    var authorBlock = dp >= 0 ? trim(t.slice(0, dp)) : trim(t);
    authorBlock = authorBlock.replace(/\.+$/, "");
    csl.author = parseVancouverAuthors(authorBlock);
    if (csl.author.etal) { csl.author = csl.author.slice(); csl.author.etal = true; }

    var after = dp >= 0 ? t.slice(dp + 2) : "";
    // title = up to next ". " (or " [PhD thesis]" etc.)
    var title, rest;
    var thM = after.match(/^(.*?)\s*\[(PhD thesis|PhD dissertation)\]\.?\s*(.*)$/i);
    if (thM) {
      title = thM[1]; csl.type = "thesis"; csl.genre = thM[2];
      var instM = thM[3].match(/^\[?([^\]]+)\]?:\s*(.+?);\s*\d{4}/);
      rest = thM[3];
      if (instM) csl.publisher = trim(instM[2]).replace(/\s*;.*$/, "");
    } else {
      var tm = after.match(/^(.*?)\.\s+(.*)$/);
      if (tm) { title = tm[1]; rest = tm[2]; }
      else { title = after; rest = ""; }
    }
    csl.title = stripTrailingDot(trim(title));
    if (rest) {
      // chapter: "In: Editors, editors. Container. Place: Pub; year. p. x–y"
      var inM = rest.match(/^In:\s+(.+?)\.\s+(.+?);\s*\d{4}\.\s*p\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/i);
      if (inM) {
        csl.type = "chapter";
        csl.editor = parseVancouverAuthors(inM[1].replace(/,\s*editors?\.?$/i, ""));
        csl["container-title"] = stripTrailingDot(trim(inM[2].replace(/;\s*\d{4}\.?\s*$/, "")));
        var pl = inM[2].match(/^(.+?):\s*(.+)$/);
        if (pl) csl.publisher = trim(pl[2]);
        csl.page = inM[3] + "-" + inM[4];
      } else {
        // conference: "In: Proceedings... Place: Pub; year. p. x–y"
        var pc = rest.match(/^In:\s+(.+?)\.\s+(.+?);\s*\d{4}\.\s*p\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/i);
        if (pc) { csl.type = "paper-conference"; csl["container-title"] = stripTrailingDot(trim(pc[1])); csl.publisher = trim(pc[2]); csl.page = pc[3] + "-" + pc[4]; }
        else {
          // journal: "Container. year;vol(issue):pages"  (year already stripped conceptually)
          var cm = rest.match(/^(.+?)\.\s*(?:\d{4};)?(\d{1,4})\s*\(([^)]+)\)\s*:\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
          if (cm) { csl["container-title"] = stripTrailingDot(trim(cm[1])); csl.volume = cm[2]; csl.issue = cm[3]; csl.page = cm[4] + "-" + cm[5]; }
          else {
            var cm2 = rest.match(/^(.+?)\.\s*(?:\d{4};)?(\d{1,4})\s*:\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
            if (cm2) { csl["container-title"] = stripTrailingDot(trim(cm2[1])); csl.volume = cm2[2]; csl.page = cm2[3] + "-" + cm2[4]; }
            else {
              // book: "Place: Pub; year."  / "[Place]: Pub; year."
              var bk = rest.match(/^(.+?):\s*(.+?);\s*\d{4}\.?\s*$/);
              if (bk) { csl["publisher-place"] = trim(bk[1]).replace(/^\[|\]$/g, ""); csl.publisher = trim(bk[2]); csl.type = "book"; }
              else csl["container-title"] = stripTrailingDot(trim(rest));
            }
          }
        }
      }
    }
    if (/arxiv preprint/i.test(rest || after)) csl.type = "article";
    if (csl.URL && !csl.volume && !csl["container-title"]) csl.type = "webpage";
    return buildEntry(text, csl, issues);
  }

  /* ---- Nature ---- */
  function extractNature(text) {
    var issues = [];
    var ids = extractIdentifiers(text);
    var t = stripAccessedPhrases(ids.rest);
    var yr = findYear(t);
    var year = yr ? yr.value : null;
    var csl = { id: null, type: "article-journal" };
    if (year) csl.issued = { "date-parts": [[year]] };
    applyIds(csl, ids);

    var parsed = parseNatureAuthors(t);
    csl.author = parsed.authors;
    if (csl.author.etal) { csl.author = csl.author.slice(); csl.author.etal = true; }
    var rest = parsed.rest;

    // title = up to ". " then container+vol+pages+(year)
    var title, afterTitle;
    var thM = rest.match(/^(.*?)\s*\((PhD thesis)\)/i);
    var titleM;
    if (thM) {
      csl.title = stripTrailingDot(trim(thM[1]));
      csl.type = "thesis"; csl.genre = thM[2];
      var inst = rest.match(/\((PhD thesis)\),?\s*\(([^)]+)\)/i);
      if (inst) csl.publisher = trim(inst[2]);
      return buildEntry(text, csl, issues);
    }
    // book: "Title. (Publisher, Place, year)."
    var bkM = rest.match(/^(.*?)\.\s*\((.+?),\s*(.+?),\s*\d{4}\)\.?\s*$/);
    if (bkM && !/ vol /.test(rest)) {
      csl.title = stripTrailingDot(trim(bkM[1]));
      csl.publisher = trim(bkM[2]); csl["publisher-place"] = trim(bkM[3]);
      csl.type = "book";
      return buildEntry(text, csl, issues);
    }
    // chapter: "Title. in Container (eds. X) pages (Pub, Place, year)."
    var chM = rest.match(/^(.*?)\.\s*in\s+(.+?)\s+\(eds?\.\s+(.+?)\)\s+(\d{1,6})\s*[\u2013-]\s*(\d{1,6})\s*\((.+?),\s*(.+?),\s*\d{4}\)/i);
    if (chM) {
      csl.title = stripTrailingDot(trim(chM[1]));
      csl.type = "chapter";
      csl["container-title"] = stripTrailingDot(trim(chM[2]));
      csl.editor = parseNatureAuthors("Salazar, B. & Kimura, T.").authors; // placeholder, overwritten below
      csl.editor = parseIeeeAuthors(chM[3]);
      csl.page = chM[4] + "-" + chM[5];
      csl.publisher = trim(chM[6]); csl["publisher-place"] = trim(chM[7]);
      return buildEntry(text, csl, issues);
    }
    // conference: "Title. in Proceedings... pages (Pub, Place, year). doi"
    var pcM = rest.match(/^(.*?)\.\s*in\s+(.+?)\s+(\d{1,6})\s*[\u2013-]\s*(\d{1,6})\s*\((.+?),\s*(.+?),\s*\d{4}\)/i);
    if (pcM) {
      csl.title = stripTrailingDot(trim(pcM[1]));
      csl.type = "paper-conference";
      csl["container-title"] = stripTrailingDot(trim(pcM[2]));
      csl.page = pcM[3] + "-" + pcM[4];
      csl.publisher = trim(pcM[5]); csl["publisher-place"] = trim(pcM[6]);
      return buildEntry(text, csl, issues);
    }
    // journal: "Title. Container vol, pages (year)."
    var jm = rest.match(/^(.*?)\.\s+(.+?)\s+(\d{1,4})\s*,\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})\s*\(\d{4}\)/);
    if (jm) {
      csl.title = stripTrailingDot(trim(jm[1]));
      csl["container-title"] = stripTrailingDot(trim(jm[2]));
      csl.volume = jm[3]; csl.page = jm[4] + "-" + jm[5];
      return buildEntry(text, csl, issues);
    }
    // arxiv: "Title. arXiv preprint Preprint at URL (year)."
    var axM = rest.match(/^(.*?)\.\s*arXiv preprint/i);
    if (axM) { csl.title = stripTrailingDot(trim(axM[1])); csl.type = "article"; csl["container-title"] = "arXiv preprint"; return buildEntry(text, csl, issues); }
    // webpage: "Title. Container URL (year)."
    var wm = rest.match(/^(.*?)\.\s*(.+?)\s+https?:\/\//);
    if (wm) { csl.title = stripTrailingDot(trim(wm[1])); csl["container-title"] = stripTrailingDot(trim(wm[2])); csl.type = "webpage"; return buildEntry(text, csl, issues); }
    // fallback
    var fb = rest.match(/^(.*?)\.\s+(.*)$/);
    if (fb) { csl.title = stripTrailingDot(trim(fb[1])); csl["container-title"] = stripTrailingDot(trim(fb[2])); }
    else csl.title = stripTrailingDot(trim(rest));
    return buildEntry(text, csl, issues);
  }

  /* ---- IEEE ---- */
  function extractIeee(text) {
    var issues = [];
    var ids = extractIdentifiers(text);
    var t = stripAccessedPhrases(ids.rest);
    var yr = findYear(t);
    var year = yr ? yr.value : null;
    var csl = { id: null, type: "article-journal" };
    if (year) csl.issued = { "date-parts": [[year]] };
    applyIds(csl, ids);

    // authors = up to first quote
    var q = t.indexOf('"');
    var authorBlock = q >= 0 ? trim(t.slice(0, q)) : trim(t);
    authorBlock = authorBlock.replace(/[.,;]+$/, "").replace(/\s+$/, "");
    csl.author = parseIeeeAuthors(authorBlock);
    if (csl.author.etal) { csl.author = csl.author.slice(); csl.author.etal = true; }

    var after = q >= 0 ? t.slice(q) : "";
    var tm = after.match(/^"([^"]+)"\s*,?\s*(.*)$/);
    var title, rest;
    if (tm) { title = tm[1]; rest = tm[2]; }
    else { title = ""; rest = after; }
    csl.title = stripTrailingDot(trim(title));
    if (rest) {
      // chapter: "in Container, X. Eds., Place: Pub, year, pp. x–y"
      var inM = rest.match(/^in\s+(.+?)\s*,\s*(.+?),\s*Eds\.\s*,?\s*(.+?):\s*(.+?),\s*\d{4},\s*pp\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/i);
      if (inM) {
        csl.type = "chapter";
        csl["container-title"] = stripTrailingDot(trim(inM[1]));
        csl.editor = parseIeeeAuthors(inM[2]);
        csl["publisher-place"] = trim(inM[3]); csl.publisher = trim(inM[4]);
        csl.page = inM[5] + "-" + inM[6];
      } else {
        var inM2 = rest.match(/^in\s+(.+?)\s*,\s*(.+?),\s*Eds\.\s*,?\s*(.+?):\s*(.+?),\s*\d{4},\s*pp\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/i);
        if (inM2) {
          csl.type = "chapter";
          csl["container-title"] = stripTrailingDot(trim(inM2[1]));
          csl.editor = parseIeeeAuthors(inM2[2]);
          csl["publisher-place"] = trim(inM2[3]); csl.publisher = trim(inM2[4]);
          csl.page = inM2[5] + "-" + inM2[6];
        } else {
          // conference: "in Proceedings..., Place: Pub, year, pp. x–y"
          var pc = rest.match(/^in\s+(.+?),\s*(.+?):\s*(.+?),\s*\d{4},\s*pp\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/i);
          if (pc) { csl.type = "paper-conference"; csl["container-title"] = stripTrailingDot(trim(pc[1])); csl["publisher-place"] = trim(pc[2]); csl.publisher = trim(pc[3]); csl.page = pc[4] + "-" + pc[5]; }
          else {
            // thesis: "PhD thesis, Inst, Place, year."
            var th = rest.match(/^PhD thesis,\s*(.+?),\s*(.+?),\s*\d{4}/i);
            if (th) { csl.type = "thesis"; csl.genre = "PhD thesis"; csl.publisher = trim(th[1]); csl["publisher-place"] = trim(th[2]); }
            else {
              // book: "Place: Pub, year."
              var bk = rest.match(/^(.+?):\s*(.+?),\s*\d{4}\.?\s*$/);
              if (bk && !/vol\./i.test(rest)) { csl.type = "book"; csl["publisher-place"] = trim(bk[1]); csl.publisher = trim(bk[2]); }
              else {
                // journal: "Container, vol. X, no. Y, pp. Z, year"
                var cm = rest.match(/^(.+?),\s*vol\.\s*(\d{1,4})\s*,\s*no\.\s*([0-9\u2013-]+)\s*,\s*pp\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/i);
                if (cm) { csl["container-title"] = stripTrailingDot(trim(cm[1])); csl.volume = cm[2]; csl.issue = cm[3]; csl.page = cm[4] + "-" + cm[5]; }
                else {
                  var cm2 = rest.match(/^(.+?),\s*vol\.\s*(\d{1,4})\s*,\s*pp\.\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/i);
                  if (cm2) { csl["container-title"] = stripTrailingDot(trim(cm2[1])); csl.volume = cm2[2]; csl.page = cm2[3] + "-" + cm2[4]; }
                  else csl["container-title"] = stripTrailingDot(trim(rest));
                }
              }
            }
          }
        }
      }
    }
    if (/\[Online\]/i.test(text) && !csl.volume) csl.type = "webpage";
    return buildEntry(text, csl, issues);
  }

  /* ---- ACS ---- */
  function extractAcs(text) {
    var issues = [];
    var ids = extractIdentifiers(text);
    var t = stripAccessedPhrases(ids.rest);
    var yr = findYear(t);
    var year = yr ? yr.value : null;
    var csl = { id: null, type: "article-journal" };
    if (year) csl.issued = { "date-parts": [[year]] };
    applyIds(csl, ids);

    var pa = parseAcsAuthors(t);
    csl.author = pa.authors;
    if (csl.author.etal) { csl.author = csl.author.slice(); csl.author.etal = true; }
    var titleAndRest = pa.titleAndRest;

    // title = up to ". " then container + year, vol(issue), pages
    var title, rest;
    var thM = titleAndRest.match(/^(.*?)\.\s*(PhD thesis)\s*,\s*(.+?),\s*\d{4}/i);
    if (thM) {
      csl.title = stripTrailingDot(trim(thM[1])); csl.type = "thesis"; csl.genre = thM[2]; csl.publisher = trim(thM[3]);
      return buildEntry(text, csl, issues);
    }
    var inM = titleAndRest.match(/^(.*?)\.\s*In\s+(.+?);\s*(.+?),\s*Eds\.\s*;\s*(.+?):\s*(.+?),\s*\d{4};\s*pp\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/i);
    if (inM) {
      csl.title = stripTrailingDot(trim(inM[1])); csl.type = "chapter";
      csl["container-title"] = stripTrailingDot(trim(inM[2]));
      csl.editor = parseAcsAuthors(inM[3]).authors;
      csl["publisher-place"] = trim(inM[4]); csl.publisher = trim(inM[5]); csl.page = inM[6] + "-" + inM[7];
      return buildEntry(text, csl, issues);
    }
    var inM2 = titleAndRest.match(/^(.*?)\.\s*In\s+(.+?);\s*(.+?):\s*(.+?),\s*\d{4};\s*pp\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/i);
    if (inM2) {
      csl.title = stripTrailingDot(trim(inM2[1])); csl.type = "paper-conference";
      csl["container-title"] = stripTrailingDot(trim(inM2[2]));
      csl["publisher-place"] = trim(inM2[3]); csl.publisher = trim(inM2[4]); csl.page = inM2[5] + "-" + inM2[6];
      return buildEntry(text, csl, issues);
    }
    // book: "Title. Place: Pub, year."
    var bk = titleAndRest.match(/^(.*?)\.\s*(.+?):\s*(.+?),\s*\d{4}\.?\s*$/);
    if (bk && !/\d{1,4}\s*\(/.test(titleAndRest)) {
      csl.title = stripTrailingDot(trim(bk[1])); csl.type = "book";
      csl["publisher-place"] = trim(bk[2]); csl.publisher = trim(bk[3]);
      return buildEntry(text, csl, issues);
    }
    // journal: "Title. Container year, vol (issue), pages."
    var jm = titleAndRest.match(/^(.*?)\.\s+(.+?)\s+\d{4},\s*(\d{1,4})\s*\(([^)]+)\)\s*,\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
    if (jm) {
      csl.title = stripTrailingDot(trim(jm[1]));
      csl["container-title"] = stripTrailingDot(trim(jm[2]));
      csl.volume = jm[3]; csl.issue = jm[4]; csl.page = jm[5] + "-" + jm[6];
      return buildEntry(text, csl, issues);
    }
    var jm2 = titleAndRest.match(/^(.*?)\.\s+(.+?)\s+\d{4},\s*(\d{1,4})\s*,\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
    if (jm2) {
      csl.title = stripTrailingDot(trim(jm2[1]));
      csl["container-title"] = stripTrailingDot(trim(jm2[2]));
      csl.volume = jm2[3]; csl.page = jm2[4] + "-" + jm2[5];
      return buildEntry(text, csl, issues);
    }
    // arxiv: "Title. arXiv preprint. year."
    var ax = titleAndRest.match(/^(.*?)\.\s*arXiv preprint/i);
    if (ax) { csl.title = stripTrailingDot(trim(ax[1])); csl.type = "article"; csl["container-title"] = "arXiv preprint"; return buildEntry(text, csl, issues); }
    // webpage: "Title. Container. URL (accessed ...)"
    var wm = titleAndRest.match(/^(.*?)\.\s+(.+?)\.\s*https?:\/\//);
    if (wm) { csl.title = stripTrailingDot(trim(wm[1])); csl["container-title"] = stripTrailingDot(trim(wm[2])); csl.type = "webpage"; return buildEntry(text, csl, issues); }
    var fb = titleAndRest.match(/^(.*?)\.\s+(.*)$/);
    if (fb) { csl.title = stripTrailingDot(trim(fb[1])); csl["container-title"] = stripTrailingDot(trim(fb[2])); }
    else csl.title = stripTrailingDot(trim(titleAndRest));
    return buildEntry(text, csl, issues);
  }

  /* ---- ACM (numbered, given-first author-year-ish) ----
   * "[n]Given1 M. Last1, ..., and FirstN M. LastN. Year. Title. Container
   * Volume, Issue (Year), pages. https://doi.org/..." — books carry a
   * publisher (often "Vol. N. Publisher"), chapters start "In Proceedings".
   */
  // Parse the tail after the title: container + vol(issue) + (year) + pages,
  // or a book / chapter / proceedings / arXiv / webpage form.
  function acmRemainder(rem, csl) {
    rem = trim(rem || "").replace(/\.+$/, "");
    if (!rem) return;
    var cm = rem.match(/Chapter\s+(\d{1,4})/i);
    if (cm) csl.chapter = cm[1];
    var vm = rem.match(/Vol\.\s*(\d{1,4})/i);
    if (vm) csl.volume = vm[1];
    var pm = rem.match(/(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
    if (pm) {
      csl.page = pm[1] + "-" + pm[2];
      var before = rem.slice(0, pm.index).replace(/[,:.\s]+$/, "");
      if (before && !/Vol\.|Chapter/i.test(before)) csl.publisher = trim(before);
      return;
    }
    var ps = rem.match(/[,:]\s*(\d{1,6})\.?\s*$/);
    if (ps) csl.page = ps[1];
  }

  function extractAcmTail(rest, csl) {
    rest = trim(rest || "").replace(/\.+$/, "");
    if (!rest) return;

    // chapter / proceedings: "In Container[. ...]"
    if (/^In\s+/i.test(rest)) {
      // chapter with editors: "In Container, Editors (Eds.). Series, Vol. N. Publisher, pages"
      // (match the editors span before the generic ". " split, since an editor
      // initial like "Peter A." would otherwise break the container name)
      var edM = rest.match(/^In\s+(.+?),\s+(.+?)\s+\((?:Eds?\.?)\)\.\s+(.*)$/i);
      if (edM) {
        csl.type = "chapter";
        csl["container-title"] = stripTrailingDot(trim(edM[1]));
        csl.editor = parseAcmAuthors(edM[2]);
        acmRemainder(edM[3], csl);
        return;
      }
      var inM = rest.match(/^In\s+(.+?)\.\s+(.*)$/i);
      if (inM) {
        var cont = trim(inM[1]);
        csl["container-title"] = stripTrailingDot(trim(cont));
        csl.type = /^Proceedings of\b/i.test(cont) ? "paper-conference" : "chapter";
        acmRemainder(inM[2], csl);
      } else {
        csl["container-title"] = stripTrailingDot(trim(rest));
        csl.type = "chapter";
      }
      return;
    }

    // arXiv preprint
    if (/^arxiv preprint/i.test(rest)) {
      csl.type = "article";
      csl["container-title"] = "arXiv preprint";
      return;
    }

    // book-chapter: "Publisher, Chapter N, pages"
    var chM = rest.match(/^(.+?),\s*Chapter\s+(\d{1,4})\s*,\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/i);
    if (chM) { csl.type = "chapter"; csl.publisher = stripTrailingDot(trim(chM[1])); csl.chapter = chM[2]; csl.page = chM[3] + "-" + chM[4]; return; }

    // journal: container + vol, issue (year), pages
    var jm = rest.match(/^(.+?)\s+(\d{1,4}),\s*(\d{1,4}(?:[\u2013-]\d{1,4})?)\s*\((\d{4})\)\s*,\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
    if (jm) { csl["container-title"] = stripTrailingDot(trim(jm[1])); csl.volume = jm[2]; csl.issue = jm[3].replace(/\u2013/g, "-"); csl.page = jm[5] + "-" + jm[6]; return; }
    var jm2 = rest.match(/^(.+?)\s+(\d{1,4})\s*\((\d{4})\)\s*,\s*(\d{1,6})\s*[\u2013-]\s*(\d{1,6})/);
    if (jm2) { csl["container-title"] = stripTrailingDot(trim(jm2[1])); csl.volume = jm2[2]; csl.page = jm2[4] + "-" + jm2[5]; return; }
    var jm3 = rest.match(/^(.+?)\s+(\d{1,4}),\s*(\d{1,4}(?:[\u2013-]\d{1,4})?)\s*\((\d{4})\)\s*,\s*(\d{1,6})/);
    if (jm3) { csl["container-title"] = stripTrailingDot(trim(jm3[1])); csl.volume = jm3[2]; csl.issue = jm3[3].replace(/\u2013/g, "-"); csl.page = jm3[5]; return; }
    var jm4 = rest.match(/^(.+?)\s+(\d{1,4})\s*\((\d{4})\)\s*,\s*(\d{1,6})/);
    if (jm4) { csl["container-title"] = stripTrailingDot(trim(jm4[1])); csl.volume = jm4[2]; csl.page = jm4[4]; return; }
    var jm5 = rest.match(/^(.+?)\s+\((\d{4})\)\./);
    if (jm5) { csl["container-title"] = stripTrailingDot(trim(jm5[1])); return; }

    // book: "Vol. N. Publisher" / "Number N. Publisher"
    var vm = rest.match(/^Vol\.\s*(\d{1,4})\.\s*(.+)$/i);
    if (vm) { csl.volume = vm[1]; csl.publisher = stripTrailingDot(trim(vm[2])); csl.type = "book"; return; }
    var nm = rest.match(/^Number\s+(\d{1,4})\.\s*(.+)$/i);
    if (nm) { csl.publisher = stripTrailingDot(trim(nm[2])); csl.type = "book"; return; }

    // article id: "673092 pages" (or ", 673092 pages")
    var aim = rest.match(/^,?\s*(\d{1,6})\s+pages\.?$/i);
    if (aim) { csl.page = aim[1]; csl.type = "article"; return; }

    // book fallback: no journal signals (no "(year)", no page range) -> publisher
    if (!/\(\d{4}\)/.test(rest) && !/[\u2013-]\s*\d{1,6}/.test(rest)) {
      csl.publisher = stripTrailingDot(trim(rest));
      csl.type = "book";
      return;
    }
    csl["container-title"] = stripTrailingDot(trim(rest));
  }

  function extractAcm(text) {
    var issues = [];
    var ids = extractIdentifiers(text);
    var t = stripAccessedPhrases(ids.rest);
    var csl = { id: null, type: "article-journal" };
    applyIds(csl, ids);
    // a "https://doi.org/" remnant (DOI already captured) is not a real URL
    if (csl.URL && /^https?:\/\/(dx\.)?doi\.org\/?$/i.test(csl.URL)) delete csl.URL;

    // author-block end: first ". YYYY. " (standalone year right after the names)
    var ym = t.match(/\. ((?:19|20)\d{2})\. /);
    var year = null, authorBlock, after;
    if (ym) {
      year = parseInt(ym[1], 10);
      authorBlock = trim(t.slice(0, ym.index));
      after = trim(t.slice(ym.index + ym[0].length));
    } else {
      var yr = findYear(t);
      year = yr ? yr.value : null;
      authorBlock = yr ? trim(t.slice(0, yr.i)) : trim(t);
      after = yr ? trim(t.slice(yr.i + 4)) : t;
    }
    if (year) csl.issued = { "date-parts": [[year]] };
    authorBlock = authorBlock.replace(/\.+$/, "");
    csl.author = parseAcmAuthors(authorBlock);
    if (csl.author.etal) { csl.author = csl.author.slice(); csl.author.etal = true; }

    // title = up to the first ". "
    var tm = after.match(/^(.*?)\.\s+(.*)$/);
    var title, rest;
    if (tm) { title = tm[1]; rest = tm[2]; }
    else { title = after; rest = ""; }
    csl.title = stripTrailingDot(trim(title));

    extractAcmTail(rest, csl);

    if (/^arxiv preprint/i.test(rest)) { csl.type = "article"; if (!csl["container-title"]) csl["container-title"] = "arXiv preprint"; }
    if (csl.URL && !csl["container-title"] && !csl.volume && !csl.publisher) csl.type = "webpage";
    if (!csl["container-title"] && csl.publisher && !csl.volume && !csl.page) csl.type = "book";

    return buildEntry(text, csl, issues);
  }

  var EXTRACTORS = {
    apa: extractApa,
    harvard: extractHarvard,
    chicagoAD: extractChicagoAD,
    chicagoFull: extractChicagoFull,
    mla: extractMla,
    vancouver: extractVancouver,
    nature: extractNature,
    ieee: extractIeee,
    acs: extractAcs,
    acm: extractAcm
  };

  /* ===== section location ===== */
  function locateSection(lines, opts) {
    // lines: array of trimmed line strings. Returns { found, start, end, warnings }.
    var warnings = [];
    var headingRe;
    if (opts && opts.heading != null) {
      if (Object.prototype.toString.call(opts.heading) === "[object RegExp]") headingRe = opts.heading;
      else headingRe = new RegExp("^\\s*" + escRe(String(opts.heading)) + "\\s*$", "i");
    } else {
      // references | bibliography | works cited | literature cited, optionally with a
      // leading section number; tolerate letter-spaced "R E F E R E N C E S".
      headingRe = /^(?:\d+(?:\.\d+)*)?\s*(:?r\s*e\s*f\s*e\s*r\s*e\s*n\s*c\s*e\s*s|b\s*i\s*b\s*l\s*i\s*o\s*g\s*r\s*a\s*p\s*h\s*y|w\s*o\s*r\s*k\s*s\s*c\s*i\s*t\s*e\s*d|l\s*i\s*t\s*e\s*r\s*a\s*t\s*u\s*r\s*e\s*c\s*i\s*t\s*e\s*d|r\s*e\s*f\s*e\s*r\s*e\s*n\s*c\s*e\s*l\s*i\s*s\s*t)\s*$/i;
    }
    var lastHeading = -1;
    for (var i = 0; i < lines.length; i++) {
      if (headingRe.test(lines[i])) lastHeading = i;
    }
    if (lastHeading < 0) {
      warnings.push("no bibliography heading found; parsing whole input");
      return { found: false, start: 0, end: lines.length, warnings: warnings };
    }
    // cut at following appendix / acknowledgements / supplementary material headings
    var end = lines.length;
    var stopRe = /^(?:\d+(?:\.\d+)*)?\s*(appendix|acknowledg(e?)ments?|supplementary\s+material|supplementary\s+information)\b/i;
    for (var j = lastHeading + 1; j < lines.length; j++) {
      if (stopRe.test(lines[j])) { end = j; break; }
    }
    return { found: true, start: lastHeading + 1, end: end, warnings: warnings };
  }

  /* ===== segmentation ===== */
  function stripNumberPrefix(block) {
    return block.replace(/^\s*\[\d+\]\s*/, "")
      .replace(/^\s*\(\d+\)\s*/, "")
      .replace(/^\s*\d+\.\s+/, "");
  }

  function segmentBlocks(bodyLines, opts) {
    // bodyLines: array of line strings (no blank grouping). Group by blank lines;
    // within a block, de-hyphenate line-break hyphens and reassemble broken DOIs.
    var blocks = [];
    var cur = [];
    for (var i = 0; i < bodyLines.length; i++) {
      var ln = bodyLines[i];
      if (trim(ln) === "") {
        if (cur.length) { blocks.push(joinWrappedLines(cur).join(" ")); cur = []; }
      } else {
        cur.push(trim(ln));
      }
    }
    if (cur.length) blocks.push(joinWrappedLines(cur).join(" "));

    // forced mode
    var mode = opts && opts.segmentation ? opts.segmentation : "auto";
    if (mode === "numbered" || mode === "indent") {
      // keep blocks as-is (blank-line grouping already done)
    }
    // drop empty blocks
    var cleaned = [];
    for (var k = 0; k < blocks.length; k++) {
      if (trim(blocks[k])) cleaned.push(blocks[k]);
    }
    return cleaned;
  }

  /* ===== core pipeline over blocks ===== */
  function parseBlocks(blocks, opts) {
    var warnings = [];
    if (!blocks.length) {
      return { sectionFound: false, style: "unknown", warnings: ["no entries found"], refs: [] };
    }
    var style = detectStyle(blocks);
    var refs = [];
    var extractor = EXTRACTORS[style] || extractApa;
    for (var i = 0; i < blocks.length; i++) {
      var raw = stripNumberPrefix(blocks[i]);
      var entry = extractor(raw);
      entry.csl.id = "ref-" + (i + 1);
      refs.push(entry);
    }
    return {
      sectionFound: true,
      style: STYLE_LABEL[style] || "unknown",
      warnings: warnings,
      refs: refs
    };
  }

  /* ===== parsePages: geometry-driven pipeline =====
   * pages: [{ lines: [{ text, y, items: [{str,x,width,height,italic?}] }] }]
   * The pdf.js text layer groups glyphs into y-bucketed lines; this pipeline
   * rebuilds reading order and entry boundaries from item geometry:
   *   1. restore spaces lost at font-run boundaries (gap between items)
   *   2. split lines whose items overlap in x (several logical lines crushed
   *      into one y-bucket) into separate track lines
   *   3. strip running heads / footers (text repeated at the same y on
   *      several pages, "Page N of M", journal folios)
   *   4. detect two-column pages and emit the left column before the right
   *   5. segment entries via numbered markers, superscript labels, and
   *      hanging indents (first line flush with the column edge)
   */

  // Rebuild line text from items, inserting a space where the geometric gap
  // between consecutive items indicates one was dropped with a font change.
  function itemsToText(items) {
    var s = "";
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (i > 0) {
        var prev = items[i - 1];
        var gap = it.x - (prev.x + (prev.width || 0));
        var h = prev.height || it.height || 10;
        if (gap > Math.max(1.0, h * 0.15) && !/\s$/.test(s) && !/^\s/.test(it.str)) s += " ";
      }
      s += it.str;
    }
    return s;
  }

  // Assign a line's items to horizontal tracks; items that overlap a previous
  // item in x, or that are separated from it by a column-sized gap, start a
  // new track. Normally yields a single track; splits merged two-column rows
  // and y-buckets that crushed several overlapping rows into one line.
  function splitOverlapTracks(items) {
    var tracks = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var x = it.x || 0;
      var end = x + (it.width || 0);
      var h = it.height || 10;
      var best = -1, bestEnd = -1e9, overlapped = false;
      for (var t = 0; t < tracks.length; t++) {
        if (tracks[t].x1 > x + 1) { overlapped = true; continue; } // x overlap -> new track
        if (x - tracks[t].x1 > Math.max(12, h * 1.5)) continue;    // column gap -> new track
        if (tracks[t].x1 > bestEnd) { best = t; bestEnd = tracks[t].x1; }
      }
      if (best < 0) {
        tracks.push({ items: [it], x0: x, x1: end, h: it.height || 0, ov: overlapped });
      } else {
        tracks[best].items.push(it);
        tracks[best].x1 = end;
        if ((it.height || 0) > tracks[best].h) tracks[best].h = it.height || 0;
      }
    }
    return tracks;
  }

  // Flatten pages to a line stream with geometry: {text,x0,x1,h,y,page,fi,ni}.
  // fi/ni describe the first item (text, height) and item count, used later
  // to spot superscript entry labels.
  function flattenPageLines(pages) {
    var out = [];
    var trackSplits = 0;
    var splitId = 0;
    var anyItems = false;
    if (!pages) return { lines: out, trackSplits: 0, anyItems: false };
    for (var p = 0; p < pages.length; p++) {
      var pls = (pages[p] && pages[p].lines) || [];
      for (var i = 0; i < pls.length; i++) {
        var L = pls[i] || {};
        var src = L.items || [];
        var items = [];
        for (var k = 0; k < src.length; k++) {
          var it = src[k];
          if (it && isStr(it.str) && trim(it.str) !== "") items.push(it);
        }
        if (!items.length) {
          if (isStr(L.text) && trim(L.text) !== "") {
            out.push({ text: foldText(trim(L.text)), x0: 0, x1: 0, h: 0, y: L.y || 0, page: p, fi: "", fiH: 0, ni: 1, col: 0 });
          }
          continue;
        }
        anyItems = true;
        var tracks = splitOverlapTracks(items);
        var overlapSplit = false;
        for (var t2 = 0; t2 < tracks.length; t2++) if (tracks[t2].ov) overlapSplit = true;
        if (overlapSplit) { trackSplits++; splitId++; }
        for (var t = 0; t < tracks.length; t++) {
          var tr = tracks[t];
          var foldedItems = [];
          for (var f = 0; f < tr.items.length; f++) {
            var fi2 = tr.items[f];
            foldedItems.push({ str: foldText(fi2.str), x: fi2.x, width: fi2.width, height: fi2.height, italic: fi2.italic });
          }
          out.push({
            text: trim(itemsToText(foldedItems)),
            items: foldedItems,
            x0: tr.x0, x1: tr.x1, h: tr.h,
            y: L.y || 0, page: p,
            fi: foldText(trim(tr.items[0].str)), fiH: tr.items[0].height || 0,
            ni: tr.items.length, col: 0,
            sp: overlapSplit ? splitId : 0
          });
        }
      }
    }
    return { lines: out, trackSplits: trackSplits, anyItems: anyItems };
  }

  // Drop left-margin line numbers (review/submission formats, e.g. ACM
  // review copies): pure-digit items that sit clearly left of the page's
  // content left edge, either alone on a line ("1693") or glued to the
  // line's first item ("1699[4]Joana B..."). Only strips when they appear
  // in bulk (>=8 per page), so legitimate numbered content is untouched.
  function stripMarginLineNumbers(lines) {
    var byPage = {}, p, i, j, L;
    for (i = 0; i < lines.length; i++) {
      p = lines[i].page;
      (byPage[p] = byPage[p] || []).push(lines[i]);
    }
    var out = [];
    for (p in byPage) {
      var pl = byPage[p];
      // content left edge: smallest x0 bucket (4pt resolution) with a
      // substantial number of letter-bearing lines
      var buckets = {}, b;
      for (j = 0; j < pl.length; j++) {
        if (!/[A-Za-z]/.test(pl[j].text)) continue;
        b = Math.round(pl[j].x0 / 4) * 4;
        buckets[b] = (buckets[b] || 0) + 1;
      }
      var edge = 1e9;
      for (b in buckets) {
        if (buckets[b] >= 5 && +b < edge) edge = +b;
      }
      if (edge === 1e9) { out = out.concat(pl); continue; }
      var limit = edge - 8;
      var isBareGutter = function (l) {
        return /^\d{1,4}$/.test(l.text) && l.x0 < limit;
      };
      var gluedIdx = function (l) {
        if (!l.items || l.items.length < 2) return false;
        var f = l.items[0], s = l.items[1];
        return /^\d{1,4}$/.test(trim(f.str)) && f.x < limit &&
          (s.x - (f.x + (f.width || 0))) > 6;
      };
      var cand = 0;
      for (j = 0; j < pl.length; j++) {
        if (isBareGutter(pl[j]) || gluedIdx(pl[j])) cand++;
      }
      if (cand < 8) { out = out.concat(pl); continue; }
      for (j = 0; j < pl.length; j++) {
        L = pl[j];
        if (isBareGutter(L)) continue;
        if (gluedIdx(L)) {
          var its = L.items.slice(1);
          out.push({
            text: trim(itemsToText(its)), items: its,
            x0: its[0].x, x1: L.x1, h: L.h, y: L.y, page: L.page,
            fi: foldText(trim(its[0].str)), fiH: its[0].height || 0,
            ni: its.length, col: L.col || 0, sp: L.sp || 0
          });
          continue;
        }
        out.push(L);
      }
    }
    return out;
  }

  // Drop running heads / footers: text repeated at ~the same y on >=2 pages,
  // "Page N of M" folios, and journal running-head patterns.
  function stripPageFurniture(lines) {
    var byText = {};
    var i, key;
    for (i = 0; i < lines.length; i++) {
      key = trim(lines[i].text);
      if (!key) continue;
      var e = byText[key] || (byText[key] = { pages: {}, ys: [] });
      e.pages[lines[i].page] = 1;
      e.ys.push(lines[i].y);
    }
    var out = [];
    for (i = 0; i < lines.length; i++) {
      var L = lines[i];
      var t = trim(L.text);
      if (!t) continue;
      if (/^Page\s+\d+\s+of\s+\d+$/i.test(t)) continue;
      if (/^\w[\w. &-]*\.\s*\d{1,3}\s*\(\d{4}\)\s*\d{1,4}\s*[–-]\s*\d{1,4}$/.test(t)) continue;
      var e2 = byText[t];
      if (e2 && t.length < 80) {
        var np = 0;
        for (var pg in e2.pages) np++;
        if (np >= 2) {
          var mn = e2.ys[0], mx = e2.ys[0];
          for (var q = 1; q < e2.ys.length; q++) {
            if (e2.ys[q] < mn) mn = e2.ys[q];
            if (e2.ys[q] > mx) mx = e2.ys[q];
          }
          if (mx - mn <= 8) continue;
        }
      }
      out.push(L);
    }
    return out;
  }

  // Detect two-column pages and reorder lines so the left column (top to
  // bottom) precedes the right column. Tags each line with .col.
  function orderColumns(lines) {
    var byPage = [];
    var i;
    for (i = 0; i < lines.length; i++) {
      var pg = lines[i].page;
      (byPage[pg] = byPage[pg] || []).push(lines[i]);
    }
    var out = [];
    for (var p = 0; p < byPage.length; p++) {
      var pl = byPage[p];
      if (!pl || !pl.length) continue;
      var minX = 1e9, maxX = -1e9;
      for (i = 0; i < pl.length; i++) {
        if (pl[i].x0 < minX) minX = pl[i].x0;
        if (pl[i].x1 > maxX) maxX = pl[i].x1;
      }
      var mid = (minX + maxX) / 2;
      var left = [], right = [];
      for (i = 0; i < pl.length; i++) {
        var L = pl[i];
        var crosses = L.x0 < mid - 20 && L.x1 > mid + 20;
        if (!crosses && L.x0 >= mid - 10) right.push(L);
        else left.push(L);
      }
      var twoCol = left.length >= 5 && right.length >= 5 && right.length >= left.length * 0.25;
      if (twoCol) {
        for (i = 0; i < left.length; i++) { left[i].col = 1; out.push(left[i]); }
        for (i = 0; i < right.length; i++) { right[i].col = 2; out.push(right[i]); }
      } else {
        for (i = 0; i < pl.length; i++) { pl[i].col = 1; out.push(pl[i]); }
      }
    }
    return out;
  }

  // Superscript entry label: a small bare number at the left edge, either
  // fused to the entry text as a separate item or on a line of its own.
  function isSupLabel(L, medH, degenerate) {
    if (!/^\d{1,3}$/.test(L.fi || "")) return false;
    if (L.ni > 1) return L.fiH < L.h * 0.8 || (degenerate && L.fiH > 0 && L.fiH <= medH);
    return trim(L.text) === L.fi && L.h > 0 && L.h < medH * 0.85;
  }

  // Segment the located section into entry blocks using line geometry.
  function segmentGeo(lines, trackSplits, warnings) {
    var i, t;
    var hs = [];
    for (i = 0; i < lines.length; i++) if (lines[i].h > 0) hs.push(lines[i].h);
    hs.sort(function (a, b) { return a - b; });
    var medH = hs.length ? hs[Math.floor(hs.length / 2)] : 10;
    // column runs: page * 4 + col; record each run's left edge and width
    var runs = {};
    var secMinX = 1e9;
    for (i = 0; i < lines.length; i++) {
      var L = lines[i];
      L.run = L.page * 4 + L.col;
      var R = runs[L.run] || (runs[L.run] = { minX: 1e9, maxX: -1e9 });
      if (L.x0 < R.minX) R.minX = L.x0;
      if (L.x1 > R.maxX) R.maxX = L.x1;
      if (L.x0 < secMinX) secMinX = L.x0;
    }
    // degenerate layout: y-buckets repeatedly carried several overlapping
    // logical lines (e.g. overlapping type from a broken producer). Measured
    // against the number of PRE-SPLIT source lines in the section: a crushed
    // bibliography has most of its source lines overlapping, while a healthy
    // two-column paper shows only a handful.
    var spIds = {}, nSpLines = 0;
    for (i = 0; i < lines.length; i++) {
      if (lines[i].sp) { spIds[lines[i].sp] = 1; nSpLines++; }
    }
    var nSp = 0;
    for (var spk in spIds) nSp++;
    var preSplit = lines.length - nSpLines + nSp;
    var degenerate = nSp >= 3 && nSp > preSplit * 0.25;
    if (degenerate) warnings.push("overlapping text lines detected; entry boundaries approximate");

    // Pre-scan entry-start signals so a stray lookalike cannot trigger them.
    // Markers must sit at the column's left edge and be followed by a capital
    // letter/quote (or end of line, for an orphan label), so wrapped fragments
    // like "(2002).", "268. https://…" or "10.1007/978-…" never count. Each
    // marker TYPE (bracket / paren / dot) is gated separately.
    var RE_BR = /^\[\d+\]\s*(?=[A-ZÀ-ɏ"'“]|$)/;
    var RE_PA = /^\(\d+\)\s*(?=[A-ZÀ-ɏ"'“]|$)/;
    var RE_DOT = /^\d{1,3}\.\s*(?=[A-ZÀ-ɏ"'“])/;
    var nBr = 0, nPa = 0, nDot = 0, supLines = 0;
    for (i = 0; i < lines.length; i++) {
      var L0 = lines[i], R0 = runs[L0.run];
      var t0 = trim(L0.text);
      if (L0.x0 <= Math.min(R0.minX, secMinX) + 3) {
        if (RE_BR.test(t0)) nBr++;
        else if (RE_PA.test(t0)) nPa++;
        else if (RE_DOT.test(t0)) nDot++;
      }
      if (isSupLabel(L0, medH, degenerate)) supLines++;
    }
    var useBr = nBr >= 3, usePa = nPa >= 3, useDot = nDot >= 3;
    var useSup = supLines >= 3;

    var blocks = [], orphans = [], cur = null;
    function closeCur() { if (cur) { blocks.push(cur); cur = null; } }
    for (i = 0; i < lines.length; i++) {
      var L2 = lines[i];
      t = trim(L2.text);
      if (!t) continue;
      var R2 = runs[L2.run];
      var start = false;
      if (useSup && isSupLabel(L2, medH, degenerate)) {
        start = true;
        if (L2.ni > 1) L2.text = t = trim(itemsToText(L2.items.slice(1)));
        else L2.text = t = "";
      }
      if (!start && ((useBr && RE_BR.test(t)) || (usePa && RE_PA.test(t)) || (useDot && RE_DOT.test(t)))) start = true; // numbered marker
      // flush = hanging-indent first line — but not right after a hyphen/URL
      // break: a hard-broken word ("Fitzg-" / "erald, M., …") re-aligns to the
      // left edge without starting a new entry
      if (!start && !degenerate && L2.x0 <= Math.min(R2.minX, secMinX) + 3) {
        var prevEndsBreak = cur && cur.texts.length &&
          /[a-z0-9][-–]$/.test(cur.texts[cur.texts.length - 1]);
        if (!prevEndsBreak) start = true;
      }
      if (!start && degenerate && (L2.x1 - L2.x0) >= (R2.maxX - R2.minX) * 0.75 &&
          /^[A-ZÀ-ɏ][\wÀ-ɏ'’-]* [A-Z]{1,3}[,.] /.test(t)) start = true;       // full-width author-start line
      if (start) {
        closeCur();
        if (t) cur = { texts: [t], h: L2.h, yLast: L2.y };
      } else if (degenerate) {
        orphans.push(L2);
      } else {
        if (!cur && (useBr || usePa || useDot)) continue; // preamble junk before the first marker
        if (!cur) cur = { texts: [], h: L2.h };
        cur.texts.push(t);
      }
    }
    closeCur();

    if (degenerate && orphans.length) {
      // Re-attach continuation lines: entries and orphan lines both appear in
      // stream order, and each orphan belongs to the next entry that still
      // looks incomplete (no year yet, or ends mid-identifier). Prefer
      // matching font heights (a stray full-size line belongs to the entry
      // typeset at full size).
      for (var b = 0; b < blocks.length && orphans.length; b++) {
        while (blockNeedsMore(blocks[b]) && orphans.length) {
          var pick = -1;
          for (var o = 0; o < orphans.length; o++) {
            if (Math.abs(orphans[o].h - blocks[b].h) <= 1.5) { pick = o; break; }
          }
          if (pick < 0) pick = 0;
          // stray entry labels from crushed buckets can hide inside orphan
          // lines; drop runs of bare small numbers
          var oText = trim(orphans[pick].text).replace(/(^|\s)\d{1,2}(?:\s+\d{1,2})+(?=\s|$)/g, "$1");
          blocks[b].texts.push(trim(oText));
          blocks[b].yLast = orphans[pick].y;
          orphans.splice(pick, 1);
        }
      }
      // leftovers cannot be placed reliably; keep them off the entry list
    }

    var out = [];
    for (i = 0; i < blocks.length; i++) {
      var joined = joinWrappedLines(blocks[i].texts).join(" ");
      if (trim(joined)) out.push(joined);
    }
    return out;
  }

  function blockNeedsMore(block) {
    var t = block.texts.join(" ");
    if (!/(19|20)\d{2}/.test(t)) return true;
    var m = t.match(/(doi:\s*\S*|https?:\/\/\S*)$/i);
    if (m && /[\/:.?&=-]$/.test(m[1])) return true;
    return false;
  }

  /* ===== public API ===== */
  function parseText(text, opts) {
    opts = opts || {};
    var folded = foldText(String(text));
    var noTags = stripItalicTags(folded, true);
    var stripped = stripHeaderFooters(noTags.text);
    var lines = stripped.split("\n");
    var loc = locateSection(lines, opts);
    var body = lines.slice(loc.start, loc.end);
    var blocks = segmentBlocks(body, opts);
    var res = parseBlocks(blocks, opts);
    res.sectionFound = loc.found;
    res.warnings = (loc.warnings || []).concat(res.warnings);
    return res;
  }

  function parsePages(pages, opts) {
    opts = opts || {};
    var warnings = [];
    var flat = flattenPageLines(pages);
    // callers that pass text-only lines (no per-item geometry) get the
    // plain-text pipeline instead
    if (!flat.anyItems) {
      var joined = [];
      for (var q = 0; q < flat.lines.length; q++) joined.push(flat.lines[q].text);
      return parseText(joined.join("\n"), opts);
    }
    var lines = stripMarginLineNumbers(flat.lines);
    lines = stripPageFurniture(lines);
    lines = orderColumns(lines);
    var texts = [];
    for (var i = 0; i < lines.length; i++) texts.push(trim(lines[i].text));
    var loc = locateSection(texts, opts);
    var body;
    if (loc.found && loc.start > 0) {
      // Drop body text that sits in a LATER column of the heading's page but
      // visually above the heading (two-column body before the bibliography).
      var H = lines[loc.start - 1];
      body = [];
      for (i = loc.start; i < loc.end; i++) {
        var bl = lines[i];
        if (bl.page === H.page && bl.col > H.col && bl.y > H.y + 3) continue;
        body.push(bl);
      }
    } else {
      body = lines.slice(loc.start, loc.end);
    }
    var blocks = segmentGeo(body, flat.trackSplits, warnings);
    var res = parseBlocks(blocks, opts);
    res.sectionFound = loc.found;
    res.warnings = (loc.warnings || []).concat(warnings, res.warnings);
    return res;
  }

  return {
    parsePages: parsePages,
    parseText: parseText,
    _internals: {
      foldText: foldText,
      extractIdentifiers: extractIdentifiers,
      findYear: findYear,
      detectStyle: detectStyle,
      fuzzyNorm: fuzzyNorm,
      parseApaAuthors: parseApaAuthors,
      parseHarvardAuthors: parseHarvardAuthors,
      parseChicagoAuthors: parseChicagoAuthors,
      parseAcsAuthors: parseAcsAuthors,
      parseVancouverAuthors: parseVancouverAuthors,
      parseNatureAuthors: parseNatureAuthors,
      parseIeeeAuthors: parseIeeeAuthors,
      parseAcmAuthors: parseAcmAuthors,
      _flattenPageLines: flattenPageLines,
      _stripMarginLineNumbers: stripMarginLineNumbers,
      _stripPageFurniture: stripPageFurniture,
      _orderColumns: orderColumns,
      _segmentGeo: segmentGeo
    }
  };
});

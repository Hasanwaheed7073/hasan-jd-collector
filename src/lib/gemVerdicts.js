/* JD Collector - parses accept/reject verdicts out of a Gemini Gem chat.
 *
 * Hasan pastes exported batches into his own Gem for vetting against a
 * client's criteria; the Gem replies with a call on each job. This does not
 * make that call - it only gives it a memory, the same way jdc_history gives
 * "already exported" a memory. A wrong REJECT here silently deletes a valid
 * job from every future run, the same failure class the hiring.cafe adapter's
 * null-vs-false rule exists to avoid - so every pattern below is anchored
 * tightly and an ambiguous line yields nothing rather than a guess.
 *
 * Pure. No DOM - runs in the service worker via importScripts, and is
 * unit-tested head-less against raw text, not against Gemini's real markup
 * (which nobody has diagnosed yet - see gem.js).
 */

(function () {
  const root = typeof window !== 'undefined' ? window : globalThis;
  if (root.JDC_GEMVERDICTS) return;

  /* An id-shaped token: LinkedIn ids are pure digits, hiring.cafe ids are
   * alphanumeric. Requiring at least one digit keeps this from matching
   * ordinary English words in the loose patterns below. */
  const ID = '(?=[A-Za-z0-9_]*\\d)[A-Za-z0-9_]{4,64}';
  const SEP = '[:\\-–—,]';

  const STRICT_RE = new RegExp(
    '^\\s*VERDICT\\s+\\b(' + ID + ')\\b\\s+(ACCEPT|REJECT)\\b\\s*' + SEP + '?\\s*(.*)$', 'i');

  /* "yes"/"no" are deliberately excluded - too generic, they show up constantly
   * in ordinary JD prose ("no sponsorship", "no clearance") and would flood the
   * ambiguous list with lines that have nothing to do with a verdict. */
  const ACCEPT_WORD = '(?:accept|approve|pursue)';
  const REJECT_WORD = '(?:reject|pass on|pass|skip)';
  const VERDICT_WORD = new RegExp('\\b(?:' + ACCEPT_WORD + '|' + REJECT_WORD + ')\\b', 'i');

  /* "1234567: reject, too junior" / "1234567 - accept" */
  const LOOSE_ID_FIRST_RE = new RegExp(
    '^\\s*#?\\b(' + ID + ')\\b\\s*' + SEP + '\\s*(' + ACCEPT_WORD + '|' + REJECT_WORD + ')\\b\\s*' +
    SEP + '?\\s*(.*)$', 'i');

  /* "reject 1234567: too junior" / "pass on 1234567" */
  const LOOSE_VERB_FIRST_RE = new RegExp(
    '^\\s*(' + ACCEPT_WORD + '|' + REJECT_WORD + ')\\b\\s*(?:on\\s+)?' + SEP + '?\\s*#?\\b(' +
    ID + ')\\b\\s*' + SEP + '?\\s*(.*)$', 'i');

  const HAS_ID_RE = new RegExp('\\b' + ID + '\\b');

  function normalizeVerdict(word) {
    return new RegExp('^(?:' + ACCEPT_WORD + ')$', 'i').test(word) ? 'accept' : 'reject';
  }

  /* Scans every line independently rather than the whole text at once, so one
   * malformed line cannot swallow the ones around it. */
  function parseVerdicts(text) {
    const lines = String(text || '').split(/\r?\n/);
    const byId = new Map();
    const ambiguous = [];

    lines.forEach(function (raw) {
      const line = raw.trim();
      if (!line) return;

      let m = STRICT_RE.exec(line);
      if (m) {
        byId.set(m[1], { jobId: m[1], verdict: m[2].toLowerCase(), reason: (m[3] || '').trim(), confidence: 'strict' });
        return;
      }

      m = LOOSE_ID_FIRST_RE.exec(line);
      if (m) {
        byId.set(m[1], { jobId: m[1], verdict: normalizeVerdict(m[2]), reason: (m[3] || '').trim(), confidence: 'loose' });
        return;
      }

      m = LOOSE_VERB_FIRST_RE.exec(line);
      if (m) {
        byId.set(m[2], { jobId: m[2], verdict: normalizeVerdict(m[1]), reason: (m[3] || '').trim(), confidence: 'loose' });
        return;
      }

      /* Looks like it might be a verdict - an id-shaped token and a verdict
       * word both present - but not in a shape any pattern above trusts.
       * Surfaced for a human to read, never auto-imported. */
      if (HAS_ID_RE.test(line) && VERDICT_WORD.test(line)) {
        ambiguous.push(line);
      }
    });

    return { matches: Array.from(byId.values()), ambiguous: ambiguous };
  }

  root.JDC_GEMVERDICTS = {
    parseVerdicts: parseVerdicts
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.JDC_GEMVERDICTS;
})();

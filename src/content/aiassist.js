/* JD Collector - AI assist, page side.
 *
 * Two jobs, both of them structural:
 *
 *   buildDigest()  describes the page the way the diagnostic does - tags,
 *                  ids, class names, a few attributes, short label text - so a
 *                  model can write selectors for a layout nobody has written
 *                  an adapter for. It is capped, it collapses repeated
 *                  siblings, and it truncates every piece of text it carries.
 *                  Job descriptions do not go into it: the model is being
 *                  asked where things are, not what they say.
 *
 *   applyPlan()    checks what came back against the live DOM and throws away
 *                  anything that does not hold up. A selector is accepted only
 *                  if it matches the right number of elements AND those
 *                  elements have the shape of the thing they claim to be - a
 *                  "description" holding 12 characters is not a description,
 *                  and a "card" matching once is the exact collapse the anchor
 *                  route already fails on.
 *
 * The model never sees a job posting and never states a fact about one. Every
 * field the extension exports still comes out of the DOM through extract.js;
 * all a plan changes is which element extract.js reads it from.
 */

(function () {
  if (window.JDC_AI) return;

  const SELM = window.JDC_SEL;
  const AIPLAN = window.JDC_AIPLAN;

  const MAX_DIGEST_CHARS = 16000;
  const MAX_DEPTH = 16;
  const MAX_TEXT = 60;
  const MAX_ATTR = 48;

  const SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, PATH: 1, CANVAS: 1,
    LINK: 1, META: 1, IMG: 1, PICTURE: 1, SOURCE: 1, VIDEO: 1, IFRAME: 1
  };

  /* ---------------- small helpers ---------------- */

  function text(el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function ownText(el) {
    if (!el || !el.childNodes) return '';
    let out = '';
    for (let i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) out += el.childNodes[i].nodeValue;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  function clip(s, n) {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  /* jsdom and any page rendered without layout report every rect as zero. Using
   * the rect check there would hide the entire document, so it only applies
   * where the browser has actually laid the page out. */
  const HAS_LAYOUT = !!(document.body &&
    document.body.getBoundingClientRect().height > 0);

  function hidden(el) {
    if (el.hidden) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    if (!HAS_LAYOUT) return false;
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0;
  }

  /* ---------------- the outline ---------------- */

  /* An href is kept because it is the most durable thing a job card has, and
   * because "which of these links is the job" is exactly the question being
   * asked. Only the path and a job id survive; nothing else from the query
   * string is carried. */
  function shortHref(el) {
    const raw = el.getAttribute && el.getAttribute('href');
    if (!raw) return '';
    try {
      const u = new URL(raw, location.href);
      const id = u.searchParams.get('currentJobId') || u.searchParams.get('jobId');
      const host = u.host === location.host ? '' : u.host;
      return clip(host + u.pathname + (id ? '?currentJobId=' + id : ''), MAX_ATTR);
    } catch (e) {
      return clip(raw, MAX_ATTR);
    }
  }

  const NOTED_ATTRS = ['role', 'aria-label', 'aria-expanded', 'type',
    'data-job-id', 'data-occludable-job-id', 'data-jobid', 'data-view-name',
    'data-test-id', 'data-testid', 'data-live-test-id'];

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';

    let cls = '';
    if (el.className && typeof el.className === 'string') {
      const parts = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 4);
      if (parts.length) cls = '.' + parts.join('.');
    }

    const attrs = [];
    NOTED_ATTRS.forEach(function (a) {
      if (!el.hasAttribute || !el.hasAttribute(a)) return;
      const v = clip(el.getAttribute(a), MAX_ATTR);
      attrs.push('[' + a + (v ? '="' + v + '"' : '') + ']');
    });
    const href = shortHref(el);
    if (href) attrs.push('[href="' + href + '"]');

    const own = ownText(el);
    const label = own ? '  "' + clip(own, MAX_TEXT) + '"' : '';

    return tag + id + cls + attrs.join('') + label;
  }

  /* Two siblings are "the same shape" when a selector written for one would
   * match the other. Collapsing those is what turns a 25-card rail into three
   * lines without losing anything a selector could key on. */
  function signature(el) {
    const cls = (el.className && typeof el.className === 'string')
      ? el.className.trim().split(/\s+/).slice(0, 3).join(' ')
      : '';
    return el.tagName + '|' + cls + '|' + el.childElementCount;
  }

  function outline(rootEl) {
    const lines = [];
    let chars = 0;
    let truncated = false;

    function emit(depth, s) {
      if (truncated) return false;
      const line = '  '.repeat(Math.min(depth, 12)) + s;
      if (chars + line.length > MAX_DIGEST_CHARS) {
        truncated = true;
        lines.push('  … outline truncated at ' + lines.length + ' lines');
        return false;
      }
      chars += line.length + 1;
      lines.push(line);
      return true;
    }

    function walk(el, depth) {
      if (truncated || !el || !el.tagName) return;
      if (SKIP_TAGS[el.tagName]) return;
      if (hidden(el)) return;
      if (!emit(depth, describe(el))) return;
      if (depth >= MAX_DEPTH) return;

      const kids = el.children;
      let i = 0;
      while (i < kids.length && !truncated) {
        const kid = kids[i];
        /* How many CONSECUTIVE siblings share this shape. Only the first is
         * expanded; the rest are counted, because a selector that matches one
         * of them matches all of them. */
        let run = 1;
        const sig = signature(kid);
        while (i + run < kids.length && signature(kids[i + run]) === sig) run++;

        walk(kid, depth + 1);
        if (run > 2) emit(depth + 1, '… ×' + (run - 1) + ' more siblings of the same shape');
        i += run;
      }
    }

    walk(rootEl, 0);
    return lines.join('\n');
  }

  /* ---------------- the digest ---------------- */

  function buildDigest(opts) {
    const o = opts || {};
    const EX = window.JDC_EX;
    const lines = [];

    lines.push('url: ' + location.origin + location.pathname);
    lines.push('query params: ' +
      (Array.from(new URL(location.href).searchParams.keys()).join(', ') || '(none)'));
    lines.push('');

    lines.push('WHAT THE HAND-WRITTEN SELECTORS RESOLVE RIGHT NOW');
    const health = EX ? EX.selectorHealth() : {};
    Object.keys(health).forEach(function (k) {
      lines.push('  ' + k.padEnd(13) + (health[k] || 'NO MATCH'));
    });
    lines.push('');

    lines.push('WHAT STRUCTURE ALONE FINDS');
    let genericCards = [];
    let shapeCards = [];
    try { genericCards = SELM.genericCards(); } catch (e) { /* degrade */ }
    try { shapeCards = SELM.genericCardsByShape(); } catch (e) { /* degrade */ }
    const anchors = SELM.jobAnchors();
    const ids = {};
    anchors.forEach(function (a) {
      const id = SELM.jobIdFromAttrs(a);
      if (id) ids[id] = 1;
    });
    lines.push('  elements carrying a job id: ' + anchors.length +
      ' (' + Object.keys(ids).length + ' distinct ids)');
    lines.push('  cards found by job link: ' + genericCards.length);
    lines.push('  cards found by repeated shape: ' + shapeCards.length);
    const desc = EX ? EX.descriptionEl() : null;
    lines.push('  description candidate: ' +
      (desc ? desc.tagName.toLowerCase() + ', ' + text(desc).length + ' chars' : 'none'));
    lines.push('');

    lines.push('OUTLINE — hidden elements omitted, repeated siblings collapsed,');
    lines.push('text truncated to ' + MAX_TEXT + ' characters.');
    const root = document.querySelector('main') || document.body;
    lines.push(outline(root));

    return lines.join('\n');
  }

  /* ---------------- checking a plan against the page ---------------- */

  function matchesOf(sel) {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch (e) {
      return null;   // not valid CSS
    }
  }

  function validateOne(key, sel) {
    const rule = AIPLAN.RULES[key];
    if (!rule) return { ok: false, why: 'not a field the collector uses' };
    if (AIPLAN.BROAD_RE.test(sel)) return { ok: false, why: 'too broad to mean anything' };

    const els = matchesOf(sel);
    if (els === null) return { ok: false, why: 'not valid CSS' };

    const min = rule.min || 1;
    if (els.length < min) {
      return { ok: false, why: 'matched ' + els.length + ' element(s), needs ' + min };
    }

    const first = els[0];
    if (first === document.body || first === document.documentElement) {
      return { ok: false, why: 'resolves to the whole page' };
    }

    const t = text(first);
    if (rule.minText && t.length < rule.minText) {
      return { ok: false, why: 'first match holds ' + t.length + ' characters, needs ' + rule.minText };
    }
    if (rule.maxText && t.length > rule.maxText) {
      return { ok: false, why: 'first match holds ' + t.length + ' characters — too much to be a ' + key };
    }
    if (rule.minChildren && first.childElementCount < rule.minChildren) {
      return { ok: false, why: 'first match has ' + first.childElementCount + ' children, needs ' + rule.minChildren };
    }

    /* The three fields the collector clicks are also checked on what they say.
     * A plausible-looking selector for "next page" that actually addresses a
     * Premium upsell would have the collector clicking an ad on the user's own
     * logged-in session - a worse outcome than collecting nothing. */
    if (rule.label) {
      const label = (t + ' ' + (first.getAttribute('aria-label') || '')).trim();
      if (!rule.label.test(label)) {
        return { ok: false, why: 'nothing about "' + clip(label, 30) + '" says ' + key };
      }
    }

    /* A description that contains, or sits inside, the results list is the
     * densest-block failure this whole layer exists to avoid. */
    if (rule.outsideList) {
      let listRoot = null;
      try { listRoot = SELM.genericListRootAny(); } catch (e) { listRoot = null; }
      if (listRoot && (first.contains(listRoot) || listRoot.contains(first))) {
        return { ok: false, why: 'overlaps the results list' };
      }
    }

    return { ok: true, count: els.length };
  }

  /* Check every selector, then hand the survivors to the selector layer. The
   * layer refuses any key whose hand-written selectors still match, so a plan
   * can only ever fill a gap - it can never take over a working layout. */
  function applyPlan(plan) {
    const accepted = [];
    const rejected = [];
    const skipped = [];

    Object.keys(plan || {}).forEach(function (key) {
      const sel = plan[key];
      const v = validateOne(key, sel);
      if (!v.ok) {
        rejected.push({ key: key, selector: sel, why: v.why });
        return;
      }
      const learned = SELM.learn(key, sel);
      if (!learned.ok) {
        skipped.push({ key: key, selector: sel, why: learned.why });
        return;
      }
      accepted.push({ key: key, selector: sel, count: v.count });
    });

    const summary = accepted.length
      ? ('using ' + accepted.map(function (a) { return a.key; }).join(', ') +
        (rejected.length ? '; dropped ' + rejected.length + ' that did not check out' : '') +
        (skipped.length ? '; ' + skipped.length + ' already handled without it' : ''))
      : ('nothing usable — ' + rejected.length + ' rejected, ' + skipped.length + ' already handled');

    return { accepted: accepted, rejected: rejected, skipped: skipped, summary: summary };
  }

  /* The human-readable version, for the settings window. */
  function report(plan, applied) {
    const out = [];
    out.push('PLAN');
    Object.keys(plan || {}).forEach(function (k) {
      out.push('  ' + k.padEnd(12) + plan[k]);
    });
    if (!Object.keys(plan || {}).length) out.push('  (empty)');
    out.push('');
    out.push('CHECKED AGAINST THE PAGE');
    applied.accepted.forEach(function (a) {
      out.push('  USING     ' + a.key.padEnd(12) + a.count + ' match(es)  ' + a.selector);
    });
    applied.skipped.forEach(function (s) {
      out.push('  SKIPPED   ' + s.key.padEnd(12) + s.why);
    });
    applied.rejected.forEach(function (r) {
      out.push('  REJECTED  ' + r.key.padEnd(12) + r.why + '  ' + r.selector);
    });
    if (!applied.accepted.length && !applied.rejected.length && !applied.skipped.length) {
      out.push('  (nothing to check)');
    }
    return out.join('\n');
  }

  window.JDC_AI = {
    buildDigest: buildDigest,
    outline: outline,
    describe: describe,
    validateOne: validateOne,
    applyPlan: applyPlan,
    report: report
  };
})();

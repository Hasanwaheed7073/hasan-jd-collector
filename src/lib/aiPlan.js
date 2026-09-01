/* JD Collector - the AI selector plan: what is asked, how the reply is read,
 * and what a plan has to satisfy before the page will use it.
 *
 * The model's ONE job is to name CSS selectors for a layout no hand-written
 * selector matches - LinkedIn's AI job search, whose class names are build
 * hashes that rotate on every deploy. It is never asked what a job says, what
 * a job is worth, or whether a job is a fit. That distinction is the whole
 * design: a wrong selector produces an empty capture the collector already
 * reports and recovers from, whereas a model asked to read facts out of a
 * posting would produce a confident sentence nobody can trace back to the
 * page. Facts still come from the DOM, and only from the DOM.
 *
 * So nothing here is trusted on the model's word. Every selector it returns is
 * run against the real page (src/content/aiassist.js) and dropped unless it
 * matches the right number of elements with the right shape of content, and a
 * learned selector can never shadow a hand-written one that is still working.
 *
 * Pure: no DOM, no network. Runs in the service worker via importScripts, in
 * the page as a content script, and head-less in tests/aiplan.test.js.
 */

(function () {
  const root = typeof window !== 'undefined' ? window : globalThis;
  if (root.JDC_AIPLAN) return;

  /* Every field a plan may carry, what the model is told each one is, and what
   * the page must observe before accepting it. `min` is a match count; the
   * text rules are checked against the first match, which is the one q() would
   * hand to the extractor.
   *
   * The counts are not decoration. A `card` selector that matches one element
   * is the exact failure the anchor route already hits on this surface (six
   * job links collapsing to a single card), so a plan that reproduces it is
   * worth no more than no plan at all.
   *
   * `label` is stricter still, and only on the three fields the collector
   * CLICKS. Reading the wrong element yields a bad row; clicking the wrong one
   * on LinkedIn, on the user's own logged-in session, is a different class of
   * mistake - so a "next page" control that says "Job search faster with
   * Premium" is refused on its text before anything ever clicks it. */
  const RULES = {
    list: {
      what: 'the single element that directly contains the job result cards',
      min: 1, minChildren: 3, notBroad: true
    },
    card: {
      what: 'ONE job result card in that list - it must match every card, not just the first',
      min: 3
    },
    cardLink: {
      what: 'the clickable element inside a card that opens that job in the details pane',
      min: 3
    },
    title: {
      what: 'the job title in the details pane (not a card title, not page chrome)',
      min: 1, minText: 2, maxText: 160, notBroad: true
    },
    company: {
      what: 'the employer name in the details pane',
      min: 1, minText: 1, maxText: 120, notBroad: true
    },
    description: {
      what: 'the element holding the full job description body text, usually under an "About the job" label',
      min: 1, minText: 200, notBroad: true, outsideList: true
    },
    showMore: {
      what: 'the inline control that expands a clipped description ("… more" / "see more")',
      min: 1, maxText: 40, label: /(?:more|expand|show|see)/i
    },
    pills: {
      what: 'the short pills beside the title carrying workplace type, employment type, seniority or pay',
      min: 1, maxText: 60
    },
    applyButton: {
      what: 'the Apply / Easy Apply control in the details pane',
      min: 1, maxText: 40, label: /apply/i
    },
    nextPage: {
      what: 'the control that loads the next page of results, if this layout has one',
      min: 1, maxText: 40, label: /(?:next|forward|›|»|→|^\s*\d+\s*$)/i
    }
  };

  const KEYS = Object.keys(RULES);

  /* A selector that matches most of the document is never an answer, however
   * plausible the rest of the reply looks - and it is exactly what a model
   * that has run out of ideas tends to return. */
  const BROAD_RE = /^\s*(?:html|body|main|:root|\*)\s*$/i;

  const MAX_SELECTOR_CHARS = 300;

  function systemPrompt() {
    const fields = KEYS.map(function (k) {
      return '  "' + k + '": ' + RULES[k].what +
        (RULES[k].min > 1 ? ' (must match at least ' + RULES[k].min + ' elements)' : '');
    }).join('\n');

    return [
      'You are given a structural outline of a job-search page: tags, ids, class',
      'names, a few attributes and short snippets of visible label text. Element',
      'text has been truncated and job descriptions are not included.',
      '',
      'Return CSS selectors that address the parts of this page listed below.',
      'Selectors are run with document.querySelectorAll on the real page, so they',
      'must be valid CSS and must use class names and attributes exactly as they',
      'appear in the outline.',
      '',
      'Fields:',
      fields,
      '',
      'Rules:',
      '- Answer with a single JSON object and nothing else.',
      '- Omit a field, or set it to null, when the outline does not show it. A',
      '  missing field costs nothing; a wrong one is thrown away anyway, because',
      '  every selector is re-checked against the live page before it is used.',
      '- Never answer "body", "main", "html" or "*" for any field.',
      '- Prefer stable attributes (role, aria-label, data-*, href patterns) over',
      '  class names, which on this site are build hashes that change on deploy.',
      '- Do not explain. The optional "notes" field takes at most one sentence.',
      '',
      'Shape:',
      '{"list":"...","card":"...","cardLink":"...","title":"...","company":"...",',
      ' "description":"...","showMore":"...","pills":"...","applyButton":"...",',
      ' "nextPage":"...","notes":"..."}'
    ].join('\n');
  }

  function buildMessages(digest, reason) {
    return [
      { role: 'system', content: systemPrompt() },
      {
        role: 'user',
        content: [
          reason ? ('Why this is being asked: ' + reason) : 'Resolve this page.',
          '',
          'PAGE OUTLINE',
          String(digest || '')
        ].join('\n')
      }
    ];
  }

  /* ---------------- reading the reply ---------------- */

  /* MiniMax M2.7 is a reasoning model. Its thinking normally arrives in a
   * separate field, but it leaks into the content often enough - and costs
   * nothing to handle - that stripping it is cheaper than a mystery parse
   * failure in the field. An unclosed block means the reply was cut off mid
   * thought, so everything from it onwards is discarded rather than parsed. */
  function stripReasoning(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<\/(?:think|thinking|reasoning)>/gi, ' ');
    const open = s.search(/<(?:think|thinking|reasoning)>/i);
    if (open !== -1) s = s.slice(0, open);
    return s;
  }

  /* The first complete JSON object in the text, brace-matched with strings and
   * escapes respected - a selector like `[aria-label="Next {page}"]` carries
   * braces of its own, so counting them blindly finds the wrong end. */
  function firstJsonObject(text) {
    const s = String(text || '');
    const start = s.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inStr = false;
    let quote = '';
    let escaped = false;

    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return null;
  }

  /* A selector value the page is allowed to try. Arrays are joined into one
   * selector list because that is what CSS already means by a comma, and a
   * model asked for "the pills" reasonably answers with several. */
  function cleanSelector(v) {
    let s;
    if (Array.isArray(v)) {
      s = v.filter(function (x) { return typeof x === 'string' && x.trim(); })
        .map(function (x) { return x.trim(); })
        .join(', ');
    } else if (typeof v === 'string') {
      s = v.trim();
    } else {
      return null;
    }

    if (!s) return null;
    if (s.length > MAX_SELECTOR_CHARS) return null;
    if (/[\n\r]/.test(s)) return null;
    if (/^(?:null|none|n\/a|undefined)$/i.test(s)) return null;
    if (BROAD_RE.test(s)) return null;
    return s;
  }

  /* Returns { ok, plan, notes } or { ok:false, error }. Never throws: this is
   * fed whatever a free endpoint decided to say. */
  function parsePlan(text) {
    const raw = stripReasoning(text);
    const json = firstJsonObject(raw);
    if (!json) return { ok: false, error: 'no JSON object in the reply' };

    let obj;
    try {
      obj = JSON.parse(json);
    } catch (e) {
      return { ok: false, error: 'reply was not valid JSON (' + e.message + ')' };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, error: 'reply was not a JSON object' };
    }

    /* Some models wrap the answer: {"selectors": {...}} / {"plan": {...}}. */
    const inner = (obj.selectors && typeof obj.selectors === 'object') ? obj.selectors
      : (obj.plan && typeof obj.plan === 'object') ? obj.plan
        : obj;

    const plan = {};
    KEYS.forEach(function (k) {
      const sel = cleanSelector(inner[k]);
      if (sel) plan[k] = sel;
    });

    if (!Object.keys(plan).length) {
      return { ok: false, error: 'the reply named no usable selector' };
    }

    let notes = obj.notes || inner.notes;
    notes = typeof notes === 'string' ? notes.replace(/\s+/g, ' ').trim().slice(0, 400) : '';

    return { ok: true, plan: plan, notes: notes };
  }

  /* The text OpenRouter actually returned, wherever this provider put it. */
  function replyText(body) {
    const choice = body && body.choices && body.choices[0];
    if (!choice) return '';
    const msg = choice.message || {};
    if (typeof msg.content === 'string') return msg.content;
    /* Some providers return content as an array of parts. */
    if (Array.isArray(msg.content)) {
      return msg.content.map(function (p) {
        return p && typeof p.text === 'string' ? p.text : '';
      }).join('');
    }
    if (typeof choice.text === 'string') return choice.text;
    return '';
  }

  root.JDC_AIPLAN = {
    RULES: RULES,
    KEYS: KEYS,
    BROAD_RE: BROAD_RE,
    systemPrompt: systemPrompt,
    buildMessages: buildMessages,
    stripReasoning: stripReasoning,
    firstJsonObject: firstJsonObject,
    cleanSelector: cleanSelector,
    parsePlan: parsePlan,
    replyText: replyText
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.JDC_AIPLAN;
})();

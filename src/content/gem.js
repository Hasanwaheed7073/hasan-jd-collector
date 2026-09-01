/* JD Collector - reads verdict lines out of a Gemini Gem chat.
 *
 * Read-only, on purpose: no clicks, no typing into the chat, no DOM
 * injection. The only thing that leaves this page is plain text, handed back
 * to the extension's own background worker over chrome.runtime.sendMessage.
 *
 * Nobody has diagnosed Gemini's real markup yet, so this deliberately does not
 * hard-code class names the way selectors.js does for LinkedIn - guessing them
 * would be exactly the mistake this project's whole "structure over class
 * names, diagnose before guessing" approach exists to avoid (see README).
 * JDC_GEM_DIAGNOSE exists so that round trip can happen with real data instead.
 * Until then, JDC_GEM_SCAN hands back all visible conversation text: safe to
 * over-collect here because gemVerdicts.js only ever acts on lines anchored to
 * the literal VERDICT token (or a tight loose-fallback shape), so surrounding
 * noise in the text is simply ignored rather than mis-parsed.
 */

(function () {
  if (window.__JDC_GEM_LOADED__) return;
  window.__JDC_GEM_LOADED__ = true;

  function textOf(el) {
    return el ? (el.innerText || el.textContent || '') : '';
  }

  function conversationRoot() {
    return document.querySelector('main') || document.body;
  }

  function describe(el) {
    if (!el || !el.tagName) return '(none)';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
      : '';
    let line = el.tagName.toLowerCase() + cls;
    if (line.length > 120) line = line.slice(0, 117) + '...';
    return line;
  }

  /* Every chat UI renders turns as a run of sibling elements with a similar
   * shape - the same signal LinkedIn's shape-based fallback keys on in
   * selectors.js. This is a diagnostic-only guess at where those turns live;
   * it is not depended on for JDC_GEM_SCAN, which just reads all visible text. */
  function repeatedTurnGroups() {
    const root = conversationRoot();
    const parents = root.querySelectorAll('div, section, main, ol, ul, [role]');
    const groups = [];

    for (let i = 0; i < parents.length && i < 4000; i++) {
      const parent = parents[i];
      const kids = parent.children;
      if (!kids || kids.length < 2 || kids.length > 400) continue;

      const bySig = new Map();
      for (let k = 0; k < kids.length; k++) {
        const kid = kids[k];
        const len = textOf(kid).trim().length;
        if (len < 20) continue;
        const sig = kid.tagName + ':' + Math.min(6, kid.childElementCount);
        if (!bySig.has(sig)) bySig.set(sig, []);
        bySig.get(sig).push(kid);
      }
      bySig.forEach(function (members, sig) {
        if (members.length >= 2) groups.push({ parent: parent, sig: sig, members: members });
      });
    }

    groups.sort(function (a, b) { return b.members.length - a.members.length; });
    return groups;
  }

  /* Structure only - tags, classes, counts and short text samples - never a
   * full transcript, so the report is safe to paste back for tuning without
   * dumping the whole conversation. */
  function diagnose() {
    const lines = [];
    lines.push('JD COLLECTOR — GEM CHAT DIAGNOSTIC');
    lines.push('url: ' + location.origin + location.pathname);
    lines.push('');

    const root = conversationRoot();
    lines.push('conversation root: ' + describe(root));
    lines.push('total visible text: ' + textOf(root).trim().length.toLocaleString() + ' chars');
    lines.push('');

    lines.push('REPEATED-STRUCTURE CANDIDATES (possible conversation turns)');
    const groups = repeatedTurnGroups().slice(0, 6);
    if (!groups.length) lines.push('  none found');
    groups.forEach(function (g) {
      lines.push('  ' + g.members.length + ' members  ' + describe(g.parent) + '  child shape ' + g.sig);
      lines.push('    sample: "' + textOf(g.members[0]).replace(/\s+/g, ' ').trim().slice(0, 100) + '"');
    });
    lines.push('');

    const raw = textOf(root);
    const hits = raw.split(/\r?\n/).filter(function (l) { return /VERDICT\s+\S/i.test(l); });
    lines.push('lines containing the literal VERDICT token: ' + hits.length);
    hits.slice(0, 10).forEach(function (l) { lines.push('  ' + l.trim().slice(0, 140)); });

    return lines.join('\n');
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;

    if (msg.type === 'JDC_GEM_PING') {
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'JDC_GEM_DIAGNOSE') {
      let report;
      try { report = diagnose(); }
      catch (e) { report = 'Diagnostic failed: ' + (e && e.message); }
      sendResponse({ ok: true, report: report });
      return;
    }

    if (msg.type === 'JDC_GEM_SCAN') {
      try {
        sendResponse({ ok: true, text: textOf(conversationRoot()) });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
      return;
    }
  });
})();

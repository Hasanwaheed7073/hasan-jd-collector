/* Every path the browser is asked to load must resolve to a file on disk.
 *
 * This exists because a wrong importScripts path took the entire extension
 * down - not just the feature that used it. `importScripts('src/lib/x.js')`
 * from inside src/background.js resolves to src/src/lib/x.js, the service
 * worker failed to register, and nothing worked at all.
 *
 * None of the other 1000+ checks could have caught it: they load modules
 * through node's resolver, which has completely different rules from the
 * browser's. So this suite deliberately reimplements the BROWSER's resolution
 * rules and checks them against the real filesystem:
 *
 *   importScripts / executeScript files -> extension ROOT (or the script's own
 *                                          directory when the path is relative)
 *   <script src> / <link href>          -> the HTML file's own directory
 *   manifest paths                      -> extension root, always
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '\n          expected ' + JSON.stringify(expected) +
      '\n          actual   ' + JSON.stringify(actual)));
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

/* Resolve the way the browser would, and report the path it would actually
 * request - so a failure names src/src/... rather than just saying "missing". */
function resolveFromRoot(p) {
  return p.replace(/^\//, '');
}
function resolveFromDir(dir, p) {
  if (p.startsWith('/')) return resolveFromRoot(p);
  return path.posix.normalize(path.posix.join(dir, p));
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/* ------------------------------------------------------------ manifest ---- */

console.log('--- manifest paths resolve from the extension root ---');

const swPath = manifest.background && manifest.background.service_worker;
check('a service worker is declared', typeof swPath, 'string');
check('and it exists: ' + swPath, exists(resolveFromRoot(swPath)), true);

const panelPath = manifest.side_panel && manifest.side_panel.default_path;
check('the side panel page exists: ' + panelPath, exists(resolveFromRoot(panelPath)), true);

(manifest.content_scripts || []).forEach(function (cs, i) {
  (cs.js || []).forEach(function (f) {
    check('content_scripts[' + i + '] ' + f, exists(resolveFromRoot(f)), true);
  });
});

Object.keys(manifest.icons || {}).forEach(function (size) {
  check('icons[' + size + '] ' + manifest.icons[size],
    exists(resolveFromRoot(manifest.icons[size])), true);
});

const actionIcons = (manifest.action && manifest.action.default_icon) || {};
Object.keys(actionIcons).forEach(function (size) {
  check('action icon[' + size + '] ' + actionIcons[size],
    exists(resolveFromRoot(actionIcons[size])), true);
});

(manifest.web_accessible_resources || []).forEach(function (entry, i) {
  (entry.resources || []).forEach(function (r) {
    if (r.indexOf('*') !== -1) return;   // globs are not checkable
    check('web_accessible_resources[' + i + '] ' + r, exists(resolveFromRoot(r)), true);
  });
});

/* ------------------------------------------------------- importScripts ---- */

/* The bug that prompted this file. importScripts resolves against the importing
 * script's own URL, NOT the extension root - so a path that looks root-relative
 * silently doubles the directory. */
console.log('\n--- importScripts resolves against the importing script ---');

const swRel = resolveFromRoot(swPath);
const swDir = path.posix.dirname(swRel.split(path.sep).join('/'));
const swSrc = fs.readFileSync(path.join(ROOT, swRel), 'utf8');

const imports = [];
swSrc.replace(/importScripts\(\s*'([^']+)'\s*\)/g, function (_, p) { imports.push(p); return _; });
swSrc.replace(/importScripts\(\s*"([^"]+)"\s*\)/g, function (_, p) { imports.push(p); return _; });

check('at least one importScripts call is present', imports.length > 0, true);

imports.forEach(function (p) {
  const resolved = resolveFromDir(swDir, p);
  check('importScripts(' + JSON.stringify(p) + ') -> ' + resolved,
    exists(resolved), true);
});

/* The specific shape of the original bug, pinned so it cannot come back: a
 * relative path from a worker that lives in a subdirectory. */
check('a bare "src/..." path from src/background.js would NOT resolve',
  exists(resolveFromDir('src', 'src/lib/hiringcafe.js')), false);
check('and the root-absolute form does',
  exists(resolveFromDir('src', '/src/lib/hiringcafe.js')), true);

/* ------------------------------------------------------ executeScript ---- */

console.log('\n--- executeScript files resolve from the extension root ---');

const injected = [];
swSrc.replace(/files:\s*\[([^\]]+)\]/g, function (_, body) {
  body.replace(/'([^']+)'|"([^"]+)"/g, function (m, a, b) {
    injected.push(a || b);
    return m;
  });
  return _;
});

check('injected files were found', injected.length > 0, true);
injected.forEach(function (f) {
  check('executeScript ' + f, exists(resolveFromRoot(f)), true);
});

/* ------------------------------------------------------------- html ------ */

console.log('\n--- html asset paths resolve against their own page ---');

const pages = [resolveFromRoot(panelPath), 'src/manager/manager.html'];

pages.forEach(function (page) {
  if (!exists(page)) { fails++; console.log('  FAIL  page missing: ' + page); return; }

  const dir = path.posix.dirname(page.split(path.sep).join('/'));
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');

  const refs = [];
  html.replace(/<script[^>]+src="([^"]+)"/g, function (_, p) { refs.push(['script', p]); return _; });
  html.replace(/<link[^>]+href="([^"]+)"/g, function (_, p) { refs.push(['link', p]); return _; });

  check(page + ' references assets', refs.length > 0, true);

  refs.forEach(function (r) {
    if (/^(https?:)?\/\//.test(r[1])) return;   // external, not ours to check
    const resolved = resolveFromDir(dir, r[1]);
    check('  ' + page + ' ' + r[0] + ' ' + r[1] + ' -> ' + resolved,
      exists(resolved), true);
  });
});

/* Every lib the panel and the manager load must actually parse as a script the
 * browser can run - a stray control character or a syntax error in one of them
 * silently breaks the whole page. */
console.log('\n--- no stray control characters in shipped source ---');

function walk(dir, out) {
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).forEach(function (e) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) {
      if (e.name === 'vendor' || e.name === 'node_modules') return;
      walk(rel, out);
    } else if (/\.(js|html|css|json)$/.test(e.name)) {
      out.push(rel);
    }
  });
  return out;
}

const shipped = walk('src', []).concat(['manifest.json']);
let dirty = [];
shipped.forEach(function (rel) {
  const txt = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  /* Tab, newline and carriage return are legitimate; nothing else in this range
   * belongs in source. A literal 0x08 got into a regex here once, via a shell
   * that turned \\b into a backspace. */
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(txt)) dirty.push(rel);
});
check('shipped files are free of control characters', dirty, []);
console.log('  (checked ' + shipped.length + ' files under src/ plus the manifest)');

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);

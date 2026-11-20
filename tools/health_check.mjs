// Weekly health, security & privacy check for the Unofficial TMF Fund Intel Dashboard.
// Read-only: it never edits the repo. Writes health-report.md + health-status.txt.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const REPO = process.env.REPO || '';
const PAGE_URL = (process.env.PAGE_URL || '').replace(/\/?$/, '/');
const MAX_CHAIN_AGE_MIN = 90;

const fails = [], warns = [], oks = [];
const fail = (m) => fails.push(m), warn = (m) => warns.push(m), ok = (m) => oks.push(m);

const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const gh = (path, jq) => {
  try { return JSON.parse(execFileSync('gh', ['api', path, ...(jq ? ['--jq', jq] : [])], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (e) { return { __error: String(e.stderr || e.message).split('\n')[0] }; }
};

// ---------- 1. Data freshness ----------
const chain = readJSON('chain.json');
const data = readJSON('data.json');
if (!chain) fail('chain.json missing or not valid JSON');
else if (!chain.asof_utc) warn('chain.json has no `asof_utc`');
else {
  const ageMin = (Date.now() - Date.parse(chain.asof_utc)) / 60000;
  if (!Number.isFinite(ageMin)) warn(`chain.json asof_utc unreadable: ${chain.asof_utc}`);
  else if (ageMin > MAX_CHAIN_AGE_MIN) fail(`Chain reader looks stopped: last reading ${Math.round(ageMin)} min ago (${chain.asof_utc})`);
  else ok(`Chain reading fresh (${Math.round(ageMin)} min old)`);
}
if (!data) fail('data.json missing or not valid JSON');
else {
  const first = Array.isArray(data.updates) ? JSON.stringify(data.updates[0] ?? '') : '';
  if (/Week\s*\d+\s*bell/i.test(first)) ok(`This week's bell recap is at the top of updates (week ${data.week ?? '?'})`);
  else warn('Top of data.json `updates` is not a "Week N bell" recap — the Friday recap may not have run');
}

// ---------- 2. GitHub Actions runs (last 7 days) ----------
if (REPO) {
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const runs = gh(`repos/${REPO}/actions/runs?per_page=100&created=>=${since}`,
    '{workflow_runs: [.workflow_runs[] | {name, status, conclusion, html_url}]}');
  if (runs.__error) warn(`Couldn't read workflow runs: ${runs.__error}`);
  else {
    const byWf = {};
    for (const r of runs.workflow_runs || []) (byWf[r.name] ||= []).push(r); // newest first
    for (const [name, rs] of Object.entries(byWf)) {
      if (name === 'Weekly health & security check') continue;
      const failed = rs.filter((r) => r.conclusion === 'failure').length;
      const last = rs.find((r) => r.status === 'completed');
      if (last?.conclusion === 'failure') fail(`Workflow "${name}": latest run failed (${failed}/${rs.length} failed this week) — ${last.html_url}`);
      else if (failed) warn(`Workflow "${name}": ${failed}/${rs.length} runs failed this week, latest OK`);
      else ok(`Workflow "${name}": ${rs.length} runs, all OK`);
    }
    if (!Object.keys(byWf).length) warn('No workflow runs in the last 7 days');
  }
}

// ---------- 3. Live page ----------
let livePageText = '';
if (!PAGE_URL || PAGE_URL === '/') warn('GitHub Pages URL not found — live page not checked');
else {
  let chromium;
  try { ({ chromium } = createRequire('/tmp/pw/package.json')('playwright')); } catch { warn('Playwright not available — live page not checked'); }
  if (chromium) {
    const browser = await chromium.launch();
    try {
      for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [], bad = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
        page.on('response', (r) => r.status() >= 400 && r.url().startsWith(PAGE_URL) && bad.push(`${r.status()} ${r.url()}`));
        const resp = await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 60000 });
        if (!resp || !resp.ok()) fail(`Live page returned ${resp?.status() ?? 'no response'} at ${width}px`);
        if (errors.length) fail(`Page errors at ${width}px: ${errors.slice(0, 3).join(' | ')}`);
        if (bad.length) fail(`Broken files at ${width}px: ${bad.slice(0, 3).join(', ')}`);
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        if (width === 390 && sideways) fail('Page scrolls sideways on a 390px phone');
        if (width === 1280) livePageText = await page.evaluate(() => document.documentElement.outerHTML + '\n' + document.body.innerText);
        if (!errors.length && !bad.length && resp?.ok() && !(width === 390 && sideways)) ok(`Live page loads cleanly at ${width}px`);
        await page.close();
      }
    } finally { await browser.close(); }
  }
}

// ---------- 4. Privacy guard ----------
// Public files + live page must not show wallets, keys or seat numbers.
// Known public addresses (token contracts etc.) go in .github/health/allowed-addresses.txt, one per line.
const allowFile = '.github/health/allowed-addresses.txt';
const allowed = new Set(existsSync(allowFile)
  ? readFileSync(allowFile, 'utf8').split('\n').map((l) => l.split('#')[0].trim().toLowerCase()).filter(Boolean)
  : []);
const publicText = ['index.html', 'data.json', 'chain.json'].filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n') + '\n' + livePageText;
const addrs = [...new Set((publicText.match(/\b0x[a-fA-F0-9]{40}\b/g) || []).map((a) => a.toLowerCase()))];
const unknown = addrs.filter((a) => !allowed.has(a));
if (unknown.length) fail(`Privacy: ${unknown.length} address(es) on the public page not on the allow-list — confirm each is a public contract, not a wallet, then add it to ${allowFile}:\n${unknown.map((a) => '  - `' + a + '`').join('\n')}`);
else ok(`Privacy: no unlisted addresses (${addrs.length} known)`);
const keyLike = [
  [/\b(?:0x)?[a-fA-F0-9]{64}\b(?![a-fA-F0-9])/g, '64-hex value (private key or tx hash)', fail],
  [/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/g, 'GitHub token', fail],
  [/\bsk-[A-Za-z0-9]{20,}/g, 'API secret key', fail],
  [/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, 'UUID-style value (CoinMarketCap keys look like this)', warn],
];
// DexScreener pool links carry 64-hex pool IDs; those are public, so leave them out of the key scan.
const keyScanText = publicText.replace(/https:\/\/dexscreener\.com\/[A-Za-z0-9/_-]+/g, '');
for (const [re, label, report] of keyLike) {
  const n = (keyScanText.match(re) || []).length;
  if (n) report(`Privacy: ${n} × ${label} found on the public page/data — check it isn't a secret`);
}
const seatHits = [...new Set((publicText.match(/[A-Za-z]*\s*\bseat\s*(?:no\.?|number|#)\s*\d+/gi) || []).map((s) => s.trim()))];
if (seatHits.length) fail(`Privacy: seat number(s) on the public page: ${seatHits.map((s) => '`' + s + '`').join(', ')}`);
if (!fails.some((f) => f.startsWith('Privacy'))) ok('Privacy: no keys, tokens or seat numbers on the public page');

// ---------- 5. Security ----------
const leaks = readJSON('.gitleaks.json');
if (!Array.isArray(leaks)) warn('Secret scan did not produce a report');
else if (leaks.length) fail(`Secret scan: ${leaks.length} possible secret(s) in git history:\n${leaks.slice(0, 10).map((l) => `  - ${l.RuleID} in \`${l.File}\` (commit ${String(l.Commit).slice(0, 7)})`).join('\n')}`);
else ok('Secret scan: nothing found in full git history');

if (REPO) {
  for (const [kind, path] of [['Dependabot', 'dependabot/alerts?state=open'], ['Secret-scanning', 'secret-scanning/alerts?state=open'], ['Code-scanning', 'code-scanning/alerts?state=open']]) {
    const r = gh(`repos/${REPO}/${path}`);
    if (r.__error) warn(`${kind} alerts not readable (${r.__error.replace(/^gh: /, '')}) — turn it on under Settings → Code security if you want it covered`);
    else if (Array.isArray(r) && r.length) fail(`${kind}: ${r.length} open alert(s)`);
    else ok(`${kind}: no open alerts`);
  }
}

if (existsSync('package-lock.json')) {
  try {
    const out = execFileSync('npm', ['audit', '--json', '--omit=dev'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const v = JSON.parse(out).metadata?.vulnerabilities || {};
    if (v.high || v.critical) fail(`npm audit: ${v.critical || 0} critical, ${v.high || 0} high`); else ok('npm audit: no high/critical issues');
  } catch (e) {
    try { const v = JSON.parse(e.stdout).metadata?.vulnerabilities || {}; (v.high || v.critical) ? fail(`npm audit: ${v.critical || 0} critical, ${v.high || 0} high`) : warn(`npm audit: ${v.moderate || 0} moderate`); }
    catch { warn('npm audit could not run'); }
  }
}

// Workflow hygiene
const wfDir = '.github/workflows';
for (const f of existsSync(wfDir) ? readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x)) : []) {
  const y = readFileSync(`${wfDir}/${f}`, 'utf8');
  if (!/^permissions:/m.test(y)) warn(`Workflow ${f}: no top-level \`permissions:\` (defaults may be broader than needed)`);
  if (/permissions:\s*write-all/.test(y)) fail(`Workflow ${f}: uses write-all permissions`);
  if (/pull_request_target/.test(y)) warn(`Workflow ${f}: uses pull_request_target — risky with outside PRs`);
  if (/echo[^\n]*\$\{\{\s*secrets\./.test(y)) fail(`Workflow ${f}: echoes a secret into logs`);
  const unpinned = (y.match(/uses:\s*[^\s@]+@(?:main|master)\b/g) || []);
  if (unpinned.length) warn(`Workflow ${f}: action(s) pinned to a moving branch: ${unpinned.join(', ')}`);
}

// ---------- Report ----------
const status = fails.length ? 'fail' : (warns.length ? 'warn' : 'pass');
const icon = { fail: '🔴', warn: '🟡', pass: '🟢' }[status];
const report = [
  `## ${icon} Weekly health & security check — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  '',
  fails.length ? `### Needs fixing (${fails.length})\n${fails.map((m) => '- ' + m).join('\n')}\n` : '',
  warns.length ? `### Worth a look (${warns.length})\n${warns.map((m) => '- ' + m).join('\n')}\n` : '',
  `<details><summary>Passed (${oks.length})</summary>\n\n${oks.map((m) => '- ' + m).join('\n')}\n</details>`,
  '',
  '_Read-only check: nothing in the repo was changed._',
].join('\n');
writeFileSync('health-report.md', report);
// Only real failures open an issue; warnings show in the run summary (and on the open issue if one exists).
writeFileSync('health-status.txt', fails.length ? 'fail' : 'pass');
console.log(report);

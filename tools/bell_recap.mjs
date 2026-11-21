// After each bell: write the facts-only recap of the week that just closed into data.json's "What changed",
// and keep data.json's week and next bell in step with the chain. Everything comes from chain.json.
// Idempotent: does nothing if the recap for that week is already there.
import fs from 'node:fs';
const c = JSON.parse(fs.readFileSync('chain.json', 'utf8'));
const d = JSON.parse(fs.readFileSync('data.json', 'utf8'));
const FUNDS = ['argon', 'bogle', 'smaug', 'midas', 'vladd'];
let changed = false, recap = null;

// weekly housekeeping
if (c.epoch && c.epoch > (d.week || 0)) { d.week = c.epoch; changed = true; }
if (c.closes_utc && c.epoch === d.week && d.bell_utc !== c.closes_utc.replace('.000Z', 'Z')) { d.bell_utc = c.closes_utc.replace('.000Z', 'Z'); changed = true; }

// the recap, once per closed week that had votes
const A = (c.archive || []).filter(a => a.funds && Object.values(a.funds).some(x => x.chairs > 0));
const a = A[0];
if (a && !(d.updates || []).some(u => (u.text || '').startsWith(`Week ${a.week} bell`))) {
  const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
  const pct = v => (v * 100).toFixed(2).replace(/\.?0+$/, '') + '%';
  const prevA = A[1];
  const lines = FUNDS.map(f => {
    const x = a.funds[f]; if (!x) return null;
    const b = Object.entries(x.room_tokens || {}).sort((p, q) => q[1] - p[1]);
    let s = f.toUpperCase() + ' ' + (b.length ? 'backed ' + b.map(([t, v]) => { const n = x.fills?.[t]; return t + ' ' + pct(v) + (n == null ? '' : n <= 1 ? ' (fills in one Friday)' : ` (~${n} Fridays to fill a quarter of the fund)`); }).join(', ') : 'backed nothing: all to WETH');
    s += ' · ' + x.chairs + (x.enrolled_last_reading ? ` of ${x.enrolled_last_reading} enrolled seats (${Math.round(x.chairs / x.enrolled_last_reading * 100)}%)` : ' seats');
    if (x.tmf_held_last_reading != null) s += ' · $TMF held ' + pct(x.tmf_held_last_reading);
    const y = prevA?.funds?.[f];
    if (y) { const was = Object.keys(y.room_tokens || {}), now = b.map(([t]) => t);
      const add = now.filter(t => !was.includes(t)), drop = was.filter(t => !now.includes(t));
      const moved = now.filter(t => was.includes(t) && Math.abs(x.room_tokens[t] - y.room_tokens[t]) >= 0.0005).map(t => `${t} ${pct(y.room_tokens[t])} → ${pct(x.room_tokens[t])}`);
      const ch = [add.length ? 'newly backed ' + add.join(', ') : '', drop.length ? 'dropped ' + drop.join(', ') : '', moved.join(', ')].filter(Boolean);
      s += ' · since Week ' + prevA.week + ': ' + (ch.length ? ch.join('; ') : 'no change'); }
    return s;
  }).filter(Boolean);
  // the same facts in short, scannable rows for the page ("What changed")
  const rows = FUNDS.map(f => {
    const x = a.funds[f]; if (!x) return null;
    const b = Object.entries(x.room_tokens || {}).sort((p, q) => q[1] - p[1]);
    const y = prevA?.funds?.[f]; let change = '', added = [], dropped = [];
    if (y) { const was = Object.keys(y.room_tokens || {}), now = b.map(([t]) => t);
      const add = now.filter(t => !was.includes(t)), drop = was.filter(t => !now.includes(t));
      added = add; dropped = drop;
      const parts = [add.length ? 'now backs ' + add.join(', ') : '', drop.length ? 'dropped ' + drop.join(', ') : ''].filter(Boolean);
      change = parts.length ? parts.join('; ') : 'same as Week ' + prevA.week; }
    return { fund: f.toUpperCase(), backed: b.map(([t, v]) => t + ' ' + pct(v)), voted: x.enrolled_last_reading ? Math.round(x.chairs / x.enrolled_last_reading * 100) : null, change, added, dropped };
  }).filter(Boolean);
  const title = `Week ${a.week} bell`, when = et.format(new Date(a.bell_utc)) + ' ET';
  recap = `Week ${a.week} bell (${et.format(new Date(a.bell_utc))} ET): ` + lines.join('. ') + '. Rebuilt from on-chain cards (Robinhood Chain, Ballot contract).';
  d.updates = [{ date: day.format(new Date(a.bell_utc)), title, when, prev_week: prevA ? prevA.week : null, rows, note: 'Rebuilt from on-chain cards.', text: recap }].concat(d.updates || []);
  changed = true;
}
if (changed) fs.writeFileSync('data.json', JSON.stringify(d, null, 1));
if (recap) { fs.writeFileSync('/tmp/recap.txt', recap); console.log('Recap:', recap); }
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `recap=${recap ? 1 : 0}\nrecap_week=${recap ? a.week : ''}\n`);
console.log(changed ? 'data.json updated' : 'nothing to do');

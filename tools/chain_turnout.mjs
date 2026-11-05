// Chain reader: per-fund turnout AND each room, rebuilt from public Robinhood Chain data. Writes chain.json.
// Read-only. Saves fund totals only: never seat numbers, wallets or anyone's card.
//
// How the room is rebuilt (matched against vv's ballot captures, Oct 31 - Nov 1, 2026):
//  - chairs: Seats with a card this week (equals Ballot.chairsVoted)
//  - a token is BACKED when chairs holding more than half the voting weight put something on it;
//    VETOED (headed to WETH) when some chairs did but not a majority; NO CARDS when nobody did
//  - a backed token's share of the fund = chair-weighted average of every card's slot (zeros included)
//  - $TMF held = (fund value in WETH - fund's WETH) / fund value; WETH = whatever is left
import fs from 'node:fs';
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const OFFICE = '0xf658b4abdafc6c8d652742d563e9d9ab8b454475'; // DividendOffice
const BALLOT = '0xa1de85247d30eb67c83d010f9240ae81a8d744fe'; // Ballot
const DESK = '0xca50244f9135ed70add8d3cbd50ef6f6a76ba654';   // fund desk (books and fund value)
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const SEL = { enrolledCount: '1832e32f', totalWeight: '72e78e1c', chairsVoted: '9ab24d0d', currentEpoch: '76671808', closesAt: '28c13a1c',
  returnCard: '78d8e9b8', votingWeight: null, bookOf: null, navInWeth: null, registry: null, registryCount: null };
const CARD_EVENT = '0xee92f1ed31e93694564a3ba46a65231c2672ac569af59811ad35111ce5fb39b9'; // CardReturned(uint8,uint256,uint256,uint256)
const FUNDS = ['argon', 'bogle', 'smaug', 'midas', 'vladd']; // contract fund index 0..4
const OUT = process.argv[2] || 'chain.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- tiny keccak-256 for function selectors ---
function keccak(str) {
  const RC = [1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
  const r = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14]; const M = (1n << 64n) - 1n;
  const rot = (x, n) => n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M;
  const bytes = [...Buffer.from(str)]; bytes.push(1); while (bytes.length % 136) bytes.push(0); bytes[bytes.length - 1] |= 0x80;
  const s = Array(25).fill(0n);
  for (let o = 0; o < bytes.length; o += 136) { for (let i = 0; i < 17; i++) { let v = 0n; for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(bytes[o + i * 8 + b]); s[i] ^= v; }
    for (let rd = 0; rd < 24; rd++) { const C = [0,1,2,3,4].map(x => s[x] ^ s[x+5] ^ s[x+10] ^ s[x+15] ^ s[x+20]); for (let x = 0; x < 5; x++) { const D = C[(x+4)%5] ^ rot(C[(x+1)%5], 1); for (let y = 0; y < 25; y += 5) s[x+y] ^= D; }
      const B = Array(25); for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + ((2*x + 3*y) % 5) * 5] = rot(s[x + 5*y], r[x + 5*y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5*y] = B[x + 5*y] ^ (~B[(x+1)%5 + 5*y] & M & B[(x+2)%5 + 5*y]); s[0] ^= RC[rd]; } }
  let h = ''; for (let i = 0; i < 4; i++) { let v = s[i]; for (let b = 0; b < 8; b++) { h += (v & 0xffn).toString(16).padStart(2, '0'); v >>= 8n; } } return h;
}
const sel = sig => keccak(sig).slice(0, 8);
if (sel('currentEpoch()') !== SEL.currentEpoch) throw new Error('keccak self-test failed');
Object.assign(SEL, { totalSupply: sel('totalSupply()'), votingWeight: sel('votingWeight(uint256)'), bookOf: sel('bookOf(uint8,address)'), navInWeth: sel('navInWeth(uint8)'), registry: sel('registry(uint256)'), registryCount: sel('registryCount()'), symbol: sel('symbol()'), decimals: sel('decimals()'), priceInWeth: sel('priceInWeth((address,uint24,uint8),bool)') });
const PRICE_DESK = '0x5607336c73553edc65176f2256686b69e787ca0f'; // TMF's price desk (values tokens in WETH)

// --- RPC helpers ---
let id = 1;
async function rpc(method, params, soft = false) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) });
      if (r.ok) { const j = await r.json(); if (j.result !== undefined) return j.result; if (soft) return { error: j.error }; throw new Error(JSON.stringify(j.error)); }
    } catch (e) { if (i === 4) throw e; }
    await sleep(1500 * (i + 1));
  }
  throw new Error('RPC unavailable');
}
const pad = n => BigInt(n).toString(16).padStart(64, '0');
const raw = (to, s, ...a) => rpc('eth_call', [{ to, data: '0x' + s + a.map(pad).join('') }, 'latest']);
const big = async (to, s, ...a) => { const h = await raw(to, s, ...a); if (!h || h === '0x') throw new Error('empty result ' + s); return BigInt(h.slice(0, 66)); };
const num = async (...a) => Number(await big(...a));
async function pool(items, n, fn) { const out = new Array(items.length); let k = 0; await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i], i); } })); return out; }

// --- the week ---
const block = parseInt(await rpc('eth_blockNumber', []), 16);
const epoch = await num(BALLOT, SEL.currentEpoch);
const closes = new Date(await num(BALLOT, SEL.closesAt, epoch) * 1000).toISOString();
const weekStart = await num(BALLOT, SEL.closesAt, epoch - 1);
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
let startBlock = prev && prev.epoch === epoch && prev.week_start_block ? prev.week_start_block : null;
const newWeek = !!(prev && prev.epoch && prev.epoch < epoch); // the bell rang since the last reading
if (!startBlock) { const ts = async b => parseInt((await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), false])).timestamp, 16);
  let lo = Math.max(0, block - 8_000_000), hi = block; while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (await ts(m) >= weekStart) hi = m; else lo = m; } startBlock = hi; }

// --- token slots, in the desk's registry order (slot 0 is $TMF, slot 1 WETH) ---
const nSlots = await num(DESK, SEL.registryCount);
const reg = await pool([...Array(nSlots).keys()], 4, async i => { const a = '0x' + (await raw(DESK, SEL.registry, i)).slice(26, 66); const h = await raw(a, SEL.symbol);
  const off = Number(BigInt('0x' + h.slice(2, 66))) / 32, n = Number(BigInt('0x' + h.slice(2 + off * 64, 66 + off * 64)));
  return { address: a, symbol: Buffer.from(h.slice(2 + (off + 1) * 64, 2 + (off + 1) * 64 + n * 2), 'hex').toString('utf8'), decimals: await num(a, SEL.decimals) }; });
const tokens = reg.map(r => r.symbol);
if (tokens[0] !== 'TMF' || tokens[1] !== 'WETH') throw new Error('unexpected registry order: ' + tokens.slice(0, 3));

// --- cards: logs -> transactions -> decoded cards (kept in memory only) ---
// CardReturned(fund, epoch, seat, weight): topics[1] = fund, topics[2] = week (epoch), topics[3] = seat
const scanFrom = newWeek && prev.week_start_block ? Math.min(prev.week_start_block, startBlock) : startBlock;
const logs = []; { let from = scanFrom, step = 400_000; while (from <= block) { const to = Math.min(block, from + step - 1);
  const r = await rpc('eth_getLogs', [{ address: BALLOT, topics: [CARD_EVENT], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }], true);
  if (r.error) { if (step <= 500) throw new Error('getLogs failed'); step = Math.floor(step / 4); continue; } logs.push(...r); from = to + 1; if (r.length < 2000 && step < 4_000_000) step *= 2; } }
const epochOfTx = new Map(logs.map(l => [l.transactionHash, Number(BigInt(l.topics[2]))]));
const W = (h, i) => BigInt('0x' + h.slice(i * 64, i * 64 + 64));
const txs = await pool([...epochOfTx.keys()], 8, h => rpc('eth_getTransactionByHash', [h]));
const cards = []; let undecoded = 0;
for (const t of txs) { const inp = (t?.input || '').slice(2);
  if (!t || (t.to || '').toLowerCase() !== BALLOT || !inp.startsWith(SEL.returnCard)) { undecoded++; continue; }
  const h = inp.slice(8); const fund = Number(W(h, 0)); const oS = Number(W(h, 1)) / 32, oB = Number(W(h, 2)) / 32;
  const seats = Array.from({ length: Number(W(h, oS)) }, (_, i) => W(h, oS + 1 + i).toString());
  const bps = Array.from({ length: Number(W(h, oB)) }, (_, i) => Number(W(h, oB + 1 + i)));
  cards.push({ fund, seats, bps, epoch: epochOfTx.get(t.hash), block: parseInt(t.blockNumber, 16), idx: parseInt(t.transactionIndex, 16) }); }
cards.sort((a, b) => a.block - b.block || a.idx - b.idx);
{ // TEST ONLY: does any Seat return more than one card for the same fund and week? (prints counts only)
  const seen = new Map(); let dup = 0, changed = 0; const byEp = {};
  for (const c of cards) for (const st of c.seats) { const k = c.fund + ':' + c.epoch + ':' + st; byEp[c.epoch] = (byEp[c.epoch] || 0) + 1;
    if (seen.has(k)) { dup++; if (seen.get(k) !== JSON.stringify(c.bps)) changed++; } seen.set(k, JSON.stringify(c.bps)); }
  console.log('REVOTE cards_tx', cards.length, 'seat_cards_by_week', JSON.stringify(byEp), 'repeat_seat_cards', dup, 'repeat_with_different_split', changed, 'scan_from_block', scanFrom);
}
const wCache = new Map(); const weightOf = async seat => { if (!wCache.has(seat)) wCache.set(seat, await num(OFFICE, SEL.votingWeight, BigInt(seat))); return wCache.get(seat); };
// The room for one week: a Seat's latest card that week wins.
async function roomsFor(ep) {
  const last = new Map(); for (const c of cards) if (c.epoch === ep) for (const s of c.seats) last.set(c.fund + ':' + s, c);
  await pool([...last.keys()], 8, k => weightOf(k.split(':')[1]));
  const res = {};
  for (const [i, f] of FUNDS.entries()) {
    const rows = [...last.keys()].filter(k => k.startsWith(i + ':')).map(k => [last.get(k), wCache.get(k.split(':')[1])]);
    const T = rows.reduce((x, r) => x + r[1], 0); const room_tokens = {}, status = {}, support_by = {}, avg_card = {}, chairs_for = {}, flip_min = {};
    for (let s = 2; s < tokens.length; s++) {
      const support = T ? rows.filter(([c]) => (c.bps[s] || 0) > 0).reduce((x, [, w]) => x + w, 0) / T : 0;
      if (support > 0) { chairs_for[tokens[s]] = rows.filter(([c]) => (c.bps[s] || 0) > 0).length; support_by[tokens[s]] = +support.toFixed(4); avg_card[tokens[s]] = +(rows.reduce((x, [c, w]) => x + (c.bps[s] || 0) * w, 0) / T / 10000).toFixed(4); }
      // fewest chairs that already voted (heaviest first) that would need to add this token to pass 50%; counts only
      if (T && support <= 0.5) { const need = T / 2 - support * T; const ws = rows.filter(([c]) => !((c.bps[s] || 0) > 0)).map(([, w]) => w).sort((a, b) => b - a);
        let x = 0, n = 0; for (const w of ws) { if (x > need) break; x += w; n++; } flip_min[tokens[s]] = x > need ? n : null; }
      if (support > 0.5) { status[tokens[s]] = 'backed'; room_tokens[tokens[s]] = +(rows.reduce((x, [c, w]) => x + (c.bps[s] || 0) * w, 0) / T / 10000).toFixed(4); }
      else status[tokens[s]] = support > 0 ? 'vetoed' : 'no_cards';
    }
    res[f] = { chairs: rows.length, room_tokens, status, support: support_by, avg_card, chairs_for, flip_min, voted_weight: T };
  }
  return res;
}

// --- token prices in WETH from the price desk (pool fee per token from data.json) ---
const DATA = fs.existsSync('data.json') ? JSON.parse(fs.readFileSync('data.json', 'utf8')) : { tokens: [], funds: [] };
const feeOf = Object.fromEntries((DATA.tokens || []).map(t => [t.token, Math.round(t.fee * 1e6)]));
const prices = {}, depth = {}; // depth: the most the desk trades in a token each Friday (WETH), the ballot's "Slow to fill" limit
for (const r of reg.slice(2)) { const fee = feeOf[r.symbol]; if (!fee) continue;
  try { const h = await raw(PRICE_DESK, SEL.priceInWeth, r.address, fee, r.decimals, 0); const p = Number(BigInt(h.slice(0, 66))) / 1e18; if (p > 0) prices[r.symbol] = +p.toPrecision(6);
    if (h.length >= 130) { const dpt = Number(BigInt('0x' + h.slice(66, 130))) / 1e18; if (dpt > 0) depth[r.symbol] = +dpt.toPrecision(4); } } catch {} }

// --- USD from the chain only: ETH valued in USDG (a dollar token) on TMF's own price desk ---
const market = {};
if (prices.USDG > 0) { market.eth_usd = +(1 / prices.USDG).toFixed(2); market.source = "TMF price desk (ETH valued in USDG)"; market.url = 'https://robinhoodchain.blockscout.com/address/' + PRICE_DESK; market.asof_utc = new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }
// token prices in USD (on-chain WETH price x on-chain ETH), and FDV (total supply x price) for the chain's own tokens
const NATIVE = ['PONS', 'CASHCAT', 'AI', 'MANCER', 'STONKBROKER', 'DERP']; // APE (ApeCoin) and VIRTUAL are bridged and USDG is a dollar token: no on-chain FDV for them
const usd = {}, fdv = {};
if (market.eth_usd) for (const r of reg.slice(2)) { const p = prices[r.symbol]; if (!p) continue; usd[r.symbol] = +(p * market.eth_usd).toPrecision(5);
  if (NATIVE.includes(r.symbol)) { try { const sup = await big(r.address, SEL.totalSupply); const whole = Number(sup / 10n ** BigInt(Math.max(0, r.decimals - 6))) / 1e6; fdv[r.symbol] = Math.round(whole * usd[r.symbol]); } catch {} } }

// --- price history (hourly, 8 days) for 24h and 7-day changes, from on-chain prices only ---
const nowMs = Date.now();
const hist = (prev?.price_hist || []).filter(h => nowMs - Date.parse(h.t) <= 8 * 864e5 + 2 * 36e5);
if (market.eth_usd && (!hist.length || nowMs - Date.parse(hist[hist.length - 1].t) >= 55 * 6e4)) hist.push({ t: new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z'), eth: market.eth_usd, w: prices });
const near = (ago, tol) => { let best = null; for (const h of hist) { const d = Math.abs(nowMs - ago - Date.parse(h.t)); if (d <= tol && (!best || d < best.d)) best = { h, d }; } return best?.h || null; };
const changes = {};
if (market.eth_usd) { const a = near(864e5, 90 * 6e4), b = near(7 * 864e5, 3 * 36e5);
  const ch = (now, then) => then ? +((now / then - 1)).toFixed(4) : null;
  changes.ETH = { h24: ch(market.eth_usd, a?.eth), d7: ch(market.eth_usd, b?.eth) };
  for (const [t, p] of Object.entries(prices)) { const u = p * market.eth_usd; changes[t] = { h24: a?.w?.[t] ? ch(u, a.w[t] * a.eth) : null, d7: b?.w?.[t] ? ch(u, b.w[t] * b.eth) : null }; } }

// --- DexScreener (free public API; its terms allow free use with no key): market stats for the chain's own tokens ---
const DEX_TOKENS = ['PONS', 'CASHCAT', 'AI', 'MANCER', 'STONKBROKER', 'APE', 'DERP', 'VIRTUAL'];
const dex = {};
try {
  const addrs = reg.filter(r => DEX_TOKENS.includes(r.symbol));
  const r = await fetch('https://api.dexscreener.com/tokens/v1/robinhood/' + addrs.map(a => a.address).join(','), { headers: { accept: 'application/json', 'user-agent': 'tmf-fund-intel-dashboard' } });
  const pairs = r.ok ? await r.json() : [];
  for (const a of addrs) {
    const mine = pairs.filter(p => p.chainId === 'robinhood' && (p.baseToken?.address || '').toLowerCase() === a.address.toLowerCase());
    if (!mine.length) continue;
    const top = mine.slice().sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0))[0];
    dex[a.symbol] = { price_usd: Number(top.priceUsd) || null, change_24h: top.priceChange?.h24 ?? null,
      volume_24h: Math.round(mine.reduce((t, p) => t + (p.volume?.h24 || 0), 0)), liquidity_usd: Math.round(mine.reduce((t, p) => t + (p.liquidity?.usd || 0), 0)),
      market_cap: top.marketCap ?? null, fdv: top.fdv ?? null, pools: mine.length, url: top.url || ('https://dexscreener.com/robinhood/' + a.address),
      first_pool_utc: (() => { const t = Math.min(...mine.map(p => p.pairCreatedAt || Infinity)); return isFinite(t) ? new Date(t).toISOString().replace(/\.\d+Z$/, 'Z') : null; })() };
  }
} catch (e) { console.log('DexScreener skipped:', String(e).slice(0, 100)); }

// --- contract facts for the chain's own tokens, read from their on-chain code (facts only; no addresses saved) ---
// Looks for the 4-byte function selectors in the token's code (and its implementation, if it is a proxy or a minimal clone).
const FACT_SIGS = { owner: ['owner()', 'getOwner()'], mint: ['mint(address,uint256)', 'mint(uint256)', 'mint(address)'], pause: ['pause()', 'paused()'],
  blacklist: ['blacklist(address)', 'addToBlacklist(address)', 'isBlacklisted(address)', 'setBlacklist(address,bool)', 'blacklistAddress(address,bool)', 'isBlackListed(address)'],
  upgrade: ['upgradeTo(address)', 'upgradeToAndCall(address,bytes)'] };
const token_facts = {};
for (const a of reg.filter(r => DEX_TOKENS.includes(r.symbol))) {
  try {
    const code = (await rpc('eth_getCode', [a.address, 'latest'])).toLowerCase();
    let impl = null, kind = null;
    const clone = code.length <= 2 + 2 * 60 ? code.match(/73([0-9a-f]{40})5af4/) : null; // minimal proxy clones (EIP-1167 and the shorter PUSH0 form)
    if (clone) { impl = '0x' + clone[1]; kind = 'clone'; }
    else { const slot = await rpc('eth_getStorageAt', [a.address, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']);
      if (slot && BigInt(slot) !== 0n) { impl = '0x' + slot.slice(26); kind = 'proxy'; } }
    const all = code + (impl ? (await rpc('eth_getCode', [impl, 'latest'])).toLowerCase() : '');
    const has = Object.fromEntries(Object.entries(FACT_SIGS).map(([k, sigs]) => [k, sigs.some(g => all.includes('63' + sel(g)))]));
    let owner_renounced = null;
    if (has.owner) { try { const o = await raw(a.address, sel('owner()')); owner_renounced = !!o && o !== '0x' && BigInt(o.slice(0, 66)) === 0n; } catch { owner_renounced = null; } }
    token_facts[a.symbol] = { has, owner_renounced, upgradeable_proxy: kind === 'proxy', minimal_clone: kind === 'clone', first_pool_utc: dex[a.symbol]?.first_pool_utc || null, asof_utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
  } catch (e) { console.log('token facts skipped for', a.symbol, String(e).slice(0, 80)); }
}

// --- per fund, this week ---
const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const etDay = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
const rooms = await roomsFor(epoch);
// --- when cards came in: half-hour UTC buckets per fund, this week only (counts per chair, changed cards included).
// Cards never change once mined, so only cards newer than the last reading need their block's time looked up.
const ctSame = prev && prev.epoch === epoch;
const ctThrough = ctSame ? prev.card_times_block || 0 : 0;
const cardTimes = Object.fromEntries(FUNDS.map(f => [f, { ...((ctSame && prev.funds?.[f]?.card_times) || {}) }]));
{ const fresh = cards.filter(c => c.epoch === epoch && c.block > ctThrough && c.block <= block);
  const blocks = [...new Set(fresh.map(c => c.block))];
  const bts = new Map(await pool(blocks, 8, async b => [b, parseInt((await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), false])).timestamp, 16)]));
  for (const c of fresh) { const f = FUNDS[c.fund]; if (!f || !bts.get(c.block)) continue;
    const d = new Date(bts.get(c.block) * 1000); d.setUTCMinutes(d.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
    const k = d.toISOString().slice(0, 16); cardTimes[f][k] = (cardTimes[f][k] || 0) + c.seats.length; } }
const funds = {};
for (const [i, f] of FUNDS.entries()) {
  const enrolled = await num(OFFICE, SEL.enrolledCount, i), voted = await num(BALLOT, SEL.chairsVoted, i, epoch), enrolled_weight = await num(OFFICE, SEL.totalWeight, i);
  const nav = await big(DESK, SEL.navInWeth, i), wethBook = await big(DESK, SEL.bookOf, i, BigInt(WETH));
  const tmf_held = nav > 0n ? +(Number((nav - wethBook) * 1000000n / nav) / 1e6).toFixed(4) : null;
  const r = rooms[f];
  const room_weth = tmf_held == null ? null : +(1 - tmf_held - Object.values(r.room_tokens).reduce((a, b) => a + b, 0)).toFixed(4);
  // Fridays to fill, as the ballot words it: a quarter of the fund divided by the desk's per-Friday limit for that token
  const navW = Number(nav) / 1e18, fills = {};
  for (const [t, dpt] of Object.entries(depth)) fills[t] = Math.ceil((navW / 4) / dpt);
  const room = { chairs: r.chairs, tmf_held, room_weth, room_tokens: r.room_tokens, status: r.status, support: r.support, avg_card: r.avg_card, chairs_for: r.chairs_for, voted_weight: r.voted_weight, flip_min: r.flip_min, nav_weth: +navW.toFixed(4), fills };
  if (r.chairs !== voted) room.note = `cards read ${r.chairs}, contract count ${voted}`;
  // "This week" timeline: one row per day (kept current), plus a new row whenever what the room backs changes
  const history = prev && prev.epoch === epoch ? (prev.funds?.[f]?.history || []).slice() : [];
  const row = { asof_utc: now, chairs: r.chairs, tmf_held, backs: r.room_tokens };
  const L = history[history.length - 1], same = L && Object.keys(L.backs).sort().join() === Object.keys(r.room_tokens).sort().join();
  if (L && same && etDay(L.asof_utc) === etDay(now)) history[history.length - 1] = row; else history.push(row);
  funds[f] = { enrolled, voted, enrolled_weight, room, history, card_times: cardTimes[f] };
}

// --- after the bell: last week's final rooms, rebuilt from all of that week's cards ---
const archive = (prev?.archive || []).slice();
if (newWeek && !archive.some(a => a.week === prev.epoch)) {
  const fin = await roomsFor(prev.epoch);
  archive.unshift({ week: prev.epoch, bell_utc: prev.closes_utc, prices_weth: prev.prices || null, prices_asof_utc: prev.asof_utc || null, funds: Object.fromEntries(FUNDS.map(f => [f, { chairs: fin[f].chairs, room_tokens: fin[f].room_tokens,
    tmf_held_last_reading: prev.funds?.[f]?.room?.tmf_held ?? null, enrolled_last_reading: prev.funds?.[f]?.enrolled ?? null,
    voted_last_reading: prev.funds?.[f]?.voted ?? null, nav_weth_last_reading: prev.funds?.[f]?.room?.nav_weth ?? null,
    fills: Object.fromEntries(Object.keys(fin[f].room_tokens).map(t => [t, prev.funds?.[f]?.room?.fills?.[t] ?? null])) }])), note: 'Rooms at the bell rebuilt from every card returned that week; $TMF held, chairs voted, enrolled, fund size and token prices (prices_weth) are from the last reading before the bell.' });
}
archive.splice(26);

// --- heads-up: tokens a room newly backs (vv sends a capture for their fill time) ---
const alerts = []; let roomsChanged = !prev || newWeek;
for (const f of FUNDS) { const was = prev?.funds?.[f]?.room; const nowR = funds[f].room;
  const before = !prev ? null : newWeek ? [] : Object.keys(was?.room_tokens || {}), after = Object.keys(nowR.room_tokens);
  if (!before || before.slice().sort().join() !== after.slice().sort().join()) roomsChanged = true;
  if (before) for (const t of after) if (!before.includes(t)) { const fill = newWeek ? null : (DATA.funds || []).find(x => x.id === f)?.fills?.[t];
    alerts.push({ fund: f.toUpperCase(), token: t, share: nowR.room_tokens[t], fill_on_file: fill ? fill.asof : null }); } }
const out = {
  asof_utc: now, block, epoch, closes_utc: closes, week_start_block: startBlock, card_times_block: block,
  source: 'Robinhood Chain (public RPC): Ballot cards and chairsVoted; DividendOffice enrolledCount and votingWeight; fund desk navInWeth and bookOf; price desk priceInWeth',
  url: 'https://robinhoodchain.blockscout.com/address/' + BALLOT, ballot: BALLOT, dividend_office: OFFICE, desk: DESK,
  method: 'Backed = more than half of chair weight put something on the token; share = chair-weighted average of all cards; $TMF held = (fund value - fund WETH) / fund value.',
  cards_read: cards.filter(c => c.epoch === epoch).length, cards_undecoded: undecoded, prices, depth, market, usd, fdv, dex, token_facts, changes, price_hist: hist, funds, archive,
};
// Always save the reading (even if no count moved) so the page's "Updated" time shows the latest check.
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
// hand-offs for the workflow: new heads-up issues, and whether the share image needs re-rendering
if (process.env.GITHUB_OUTPUT) { fs.writeFileSync('/tmp/alerts.json', JSON.stringify({ epoch, alerts })); fs.appendFileSync(process.env.GITHUB_OUTPUT, `alerts=${alerts.length}\nog=${roomsChanged ? 1 : 0}\n`); }
console.log(JSON.stringify(Object.fromEntries(Object.entries(funds).map(([k, v]) => [k, { voted: v.voted, chairs: v.room.chairs, tmf: v.room.tmf_held, backs: v.room.room_tokens, rows: v.history.length }]))), newWeek ? 'NEW WEEK' : '');

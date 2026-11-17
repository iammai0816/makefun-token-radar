// Token launch radar — token-radar-01 entry (Node 22, standard library only).
//
// Reads the sealed snapshot (/input/snapshot.json, or --input <file|dir>, or
// $MAKEFUN_INPUT_DIR), scores every pre-token protocol with the model below,
// writes the ranked board to /output/board.json (or $MAKEFUN_OUTPUT_DIR),
// writes the dashboard's data as data.js beside the page, copies dashboard/
// and screenshots/ into /output, and writes /output/dossier.json with the
// vendored make.fun library.
//
// THE MODEL (radar-v2) — every figure comes from the snapshot itself; no
// protocol name is ever special-cased, the same function scores every row:
//
//   implied = TVL x 0.30 x categoryMult x growthMult x maturityMult x breadthMult
//
//   categoryMult  secondary signal from the protocol's DefiLlama category
//                 (Risk Curators 1.15, RWA / Onchain Capital Allocator 1.10,
//                 Lending / Yield / Restaking 1.05, Dexs 0.95, CEX / Bridge /
//                 Liquid Staking / Liquid Restaking 0.50, everything else 1.00)
//   growthMult    = 1 + clamp(change_7d, -50, +100) / 100 x 0.6
//                 (a protocol growing fast this week is worth more than one
//                 shrinking; unreported growth counts as 0)
//   maturityMult  = 0.70 + min(age_days, 1460) / 1460 x 0.50
//                 (age = as_of minus listed_at; unknown listed_at counts as
//                 180 days — a protocol that has run for years with no token
//                 has a longer, more proven record than a month-old one)
//   breadthMult   = 1 + min(chains - 1, 9) x 0.02
//                 (running on more chains is a small plus, capped at 9 extra)
//
// The board ranks PRE-TOKEN protocols only: a protocol whose DefiLlama record
// carries a market cap, a CoinGecko id or a symbol already has a token that
// trades, so it is kept apart in the dashboard's "Live tokens" section (shown
// at its recorded market cap, never mixed into the ranking). The board covers
// all 40 watchlist protocols plus the 110 highest-scoring other pre-token
// protocols — 150 rows. Farm steps are generated per protocol from its own
// facts only (name, category, chains, TVL); they say a protocol "records no
// token", never that it has none.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const MODEL_VERSION = 'radar-v2';
const BOARD_ROWS = 150;

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  watchlist: boolean;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    category_multiplier: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** Categories that are not farmable pre-token subjects, so they never rank:
 *  exchanges (a CEX is a company, not a protocol to farm), bridges and
 *  liquid-staking / restaked products (wrapped or staked products of a token
 *  that already trades). The watchlist rule already leaves these out, so
 *  excluding them costs no watchlist row; it only keeps the top of the board
 *  from being exchanges with giant TVL and nothing to farm. */
const EXCLUDED_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);

/** The chain a farm step sends funds to: prefer a smart-contract chain the
 *  protocol runs on, so a step never tells a reader to bridge USDC "to
 *  Bitcoin" for a protocol whose first listed chain is a non-programmable one. */
const PREFERRED_CHAINS = [
  'Ethereum', 'Arbitrum', 'Base', 'Solana', 'Binance', 'Optimism', 'Polygon',
  'Avalanche', 'Berachain', 'Sonic', 'Sui', 'Hyperliquid L1', 'Monad', 'Unichain',
];
function pickChain(p: Protocol): string {
  for (const c of PREFERRED_CHAINS) if (p.chains.includes(c)) return c;
  return p.chains[0] ?? 'Ethereum';
}

const CATEGORY_MULT: Record<string, number> = {
  'Risk Curators': 1.15,
  RWA: 1.1,
  'Onchain Capital Allocator': 1.1,
  Lending: 1.05,
  Yield: 1.05,
  Restaking: 1.05,
  'Yield Aggregator': 1.05,
  Dexs: 0.95,
  Derivatives: 1.0,
  'Basis Trading': 1.0,
  CDP: 1.0,
  CEX: 0.5,
  Bridge: 0.5,
  'Canonical Bridge': 0.5,
  'Liquid Staking': 0.5,
  'Liquid Restaking': 0.5,
  'Restaked BTC': 0.5,
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function ageDays(asOf: string, listedAt: string | null): number | null {
  if (!listedAt) return null;
  const ms = Date.parse(asOf) - Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86_400_000);
}

function isPreToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

function impliedValue(p: Protocol, asOf: string): { value: number; parts: BoardRow['model'] } {
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? 180;
  const growthPct = clamp(p.change_7d ?? 0, -50, 100);
  const growthMult = 1 + (growthPct / 100) * 0.6;
  const maturityMult = 0.7 + (Math.min(ageForModel, 1460) / 1460) * 0.5;
  const breadthMult = 1 + Math.min(Math.max(p.chains.length - 1, 0), 9) * 0.02;
  const catMult = CATEGORY_MULT[p.category ?? ''] ?? 1.0;
  const value = Math.max(1, Math.round(p.tvl_usd * 0.3 * catMult * growthMult * maturityMult * breadthMult));
  return {
    value,
    parts: {
      base_multiple: 0.3,
      category_multiplier: catMult,
      growth_pct: growthPct,
      growth_multiplier: Number(growthMult.toFixed(4)),
      maturity_multiplier: Number(maturityMult.toFixed(4)),
      breadth_multiplier: Number(breadthMult.toFixed(4)),
      age_days: age,
    },
  };
}

function money(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

/** The category's core on-chain action, used to build concrete farm steps. */
function categoryAction(category: string | null): { verb: string; detail: string; extra: string } {
  switch (category) {
    case 'Lending':
      return {
        verb: 'deposit as collateral and borrow against it',
        detail: 'deposit stablecoins as collateral, then borrow up to half their value in a second asset so the position stays active on both sides of the market',
        extra: 'repay or top up the loan whenever the health factor slips below 1.5 so the position is never liquidated',
      };
    case 'Dexs':
      return {
        verb: 'provide liquidity and swap through it',
        detail: 'add a two-sided liquidity position in the deepest pool and route a swap through that same pool so you are both a maker and a taker',
        extra: 'rebalance the range or pair whenever one side drifts past 70% of the position, and collect the trading fees each month',
      };
    case 'Yield':
    case 'Yield Aggregator':
      return {
        verb: 'deposit into a yield vault and compound it',
        detail: 'deposit into the vault with the largest TVL share, then claim and re-deposit the yield every two weeks so the balance compounds',
        extra: 'move the deposit to the vault with the best 7-day return only if it has held that lead for two straight weeks',
      };
    case 'RWA':
      return {
        verb: 'hold a tokenised real-world position',
        detail: 'mint or buy the protocol’s tokenised real-world asset position and hold it through at least one full yield payout cycle',
        extra: 'keep the position untouched for a full month so the holding shows as a long-term allocation rather than a flip',
      };
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
      return {
        verb: 'allocate into a curated vault',
        detail: 'allocate into the curator’s largest vault and read its allocation report each week so you can name where the capital is deployed',
        extra: 'split the allocation across two of the curator’s vaults so a single strategy failure never wipes the whole position',
      };
    case 'Derivatives':
      return {
        verb: 'open and hold a hedged derivatives position',
        detail: 'open a small perpetual or options position with 2x leverage at most, hedged by an equal spot holding, and hold it for at least a week',
        extra: 'close the position before funding costs eat the edge, and never let one trade risk more than 5% of the deposit',
      };
    case 'Restaking':
    case 'Liquid Restaking':
      return {
        verb: 'restake and keep the position staked',
        detail: 'restake the deposit through the protocol’s restaking flow and leave it staked for at least a month without unstaking',
        extra: 'delegate to a second operator after the first month so the stake is spread rather than concentrated in one place',
      };
    case 'CDP':
      return {
        verb: 'mint against collateral and hold the debt',
        detail: 'lock collateral in the protocol’s vault, mint its stable asset against it at under 50% of the collateral value, and hold the debt for a month',
        extra: 'top up collateral whenever the ratio falls under 150% so the vault is never at liquidation risk',
      };
    case 'Basis Trading':
      return {
        verb: 'run a small basis position',
        detail: 'open the protocol’s basis position with spot on one side and a short hedge on the other, sized so the funding income is the point, not the price move',
        extra: 'check the funding rate weekly and unwind if it turns negative for two weeks in a row',
      };
    default:
      return {
        verb: 'use the protocol’s core product every week',
        detail: 'use the protocol’s main product with a real deposit, not a dust amount, and repeat the same action at least once a week',
        extra: 'try the protocol’s second product too, so the activity covers more than one feature',
      };
  }
}

function farmSteps(p: Protocol, age: number | null): string[] {
  const chain = pickChain(p);
  const chain2 = p.chains.find((c) => c !== chain) ?? chain;
  const cat = p.category ?? 'protocol';
  const act = categoryAction(p.category);
  const ageText = age === null ? 'recently listed' : age < 90 ? `listed only ${age} days ago` : age < 365 ? `running for about ${Math.round(age / 30)} months` : `running for about ${(age / 365).toFixed(1)} years`;
  const steps = [
    `Bridge $100–$500 of USDC to ${chain} through the bridge you already trust, keeping the receipt: about $2–$8 in bridge fees and 10–20 minutes end to end. ${p.name} records no token, so this is positioning, not a purchase.`,
    `On ${chain}, ${act.detail} with the bridged funds in ${p.name} (${cat}, ${money(p.tvl_usd)} TVL, ${ageText}). Budget roughly $5–$15 in gas for the deposit transaction and allow 15–30 minutes to confirm the position.`,
    `Repeat the core action once a week for at least 8 weeks: ${act.verb} again in a second, smaller transaction of $25–$100, about 10 minutes each week, so the activity reads as sustained use rather than a single visit.`,
    `After a month, ${act.extra}. Then spread a second $50–$200 position to ${chain2 === chain ? 'a second pool on the same chain' : `${chain2}, the protocol’s other main chain`} to show use across more than one chain. Allow 20–30 minutes and $5–$20 in gas.`,
    `Keep a dated log of every deposit, transaction hash and weekly action in a notes file, and check the protocol’s TVL and 7-day change weekly (5 minutes). If ${p.name} ever issues a token, that log is the record of what you did and when.`,
  ];
  for (const s of steps) {
    if (s.trim().length < 20 || s.trim().length > 600) throw new Error(`farm step length ${s.length} for ${p.slug}`);
  }
  return steps;
}

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = arg('input', process.env.MAKEFUN_INPUT_DIR ?? '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot: Snapshot = JSON.parse(readFileSync(inputFile, 'utf8'));
const watchSet = new Set(snapshot.watchlist);

// Score every pre-token protocol in a farmable category, then take the watchlist plus the best others.
const scored = snapshot.protocols
  .filter(isPreToken)
  .filter((p) => !EXCLUDED_CATEGORIES.has(p.category ?? ''))
  .map((p) => {
  const { value, parts } = impliedValue(p, snapshot.as_of);
  return { p, value, parts, age: parts.age_days };
});
scored.sort((a, b) => b.value - a.value || b.p.tvl_usd - a.p.tvl_usd || a.p.slug.localeCompare(b.p.slug));
const bySlug = new Map(scored.map((s) => [s.p.slug, s]));
const picked: typeof scored = [];
for (const slug of snapshot.watchlist) {
  const s = bySlug.get(slug);
  if (s) picked.push(s);
}
for (const s of scored) {
  if (picked.length >= BOARD_ROWS) break;
  if (!watchSet.has(s.p.slug)) picked.push(s);
}
picked.sort((a, b) => b.value - a.value || b.p.tvl_usd - a.p.tvl_usd || a.p.slug.localeCompare(b.p.slug));

const board: BoardRow[] = picked.map((s, i) => ({
  rank: i + 1,
  slug: s.p.slug,
  name: s.p.name,
  category: s.p.category,
  chains: s.p.chains,
  tvl_usd: s.p.tvl_usd,
  change_7d: s.p.change_7d,
  mcap_usd: s.p.mcap_usd,
  listed_at: s.p.listed_at,
  age_days: s.age,
  token_status: 'pre-token',
  watchlist: watchSet.has(s.p.slug),
  implied_value_usd: s.value,
  model: s.parts,
  farm_steps: farmSteps(s.p, s.age),
}));

// Live-token protocols, kept apart: top 24 by recorded market cap, for the dashboard's separate section.
const live = snapshot.protocols
  .filter((p) => !isPreToken(p) && p.mcap_usd !== null)
  .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0))
  .slice(0, 24)
  .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d, mcap_usd: p.mcap_usd, listed_at: p.listed_at }));

// Gate-shape self-checks before writing anything.
const fail = (msg: string): never => {
  process.stderr.write(`token radar: ${msg}\n`);
  process.exit(1);
};
if (board.length < 100) fail(`board has ${board.length} rows, need 100+`);
if (new Set(board.map((r) => r.slug)).size !== board.length) fail('duplicate slug on board');
for (let i = 0; i < board.length; i++) {
  if (board[i]!.rank !== i + 1) fail(`rank mismatch at row ${i}`);
  if (i > 0 && board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) fail('implied value rises with rank');
  if (board[i]!.farm_steps.length < 3 || board[i]!.farm_steps.length > 12) fail(`farm_steps count for ${board[i]!.slug}`);
  for (const s of board[i]!.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) fail(`farm step length for ${board[i]!.slug}`);
}
if (board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) fail('all implied values equal');
for (const slug of snapshot.watchlist) if (!board.some((r) => r.slug === slug)) fail(`watchlist slug missing: ${slug}`);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);

const radar = {
  meta: {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: 'implied = TVL x 0.30 x categoryMult x growthMult x maturityMult x breadthMult; growthMult = 1 + clamp(change_7d, -50, 100)/100 x 0.6; maturityMult = 0.70 + min(age_days, 1460)/1460 x 0.50 (unknown age = 180 days); breadthMult = 1 + min(chains-1, 9) x 0.02',
    rows: board.length,
    watchlist: snapshot.watchlist.length,
    live_shown: live.length,
    note: 'Pre-token means the snapshot records no token (no market cap, no CoinGecko id, no symbol). It is not proof a protocol has no token.',
  },
  rows: board,
  live,
};
writeFileSync(join(out, 'data.js'), `window.RADAR = ${JSON.stringify(radar)};\n`);

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) fail(`screenshots/ holds ${shots.length} images, need 3`);
for (const name of shots) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(name)) fail(`bad screenshot name: ${name}`);
}

writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }),
);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watchlist, ${board.length} board rows (${board.filter((r) => r.watchlist).length} watchlist, ${board.filter((r) => !r.watchlist).length} early), ${live.length} live shown\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, dashboard, ${shots.length} screenshots, ${join(out, 'dossier.json')}\n`,
);

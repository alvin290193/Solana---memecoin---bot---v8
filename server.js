const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
const START_BALANCE = Math.max(10, Number(process.env.START_BALANCE || 100));
const POSITION_SIZE = Math.max(1, Number(process.env.POSITION_SIZE || 10));
const MIN_LIQUIDITY = Math.max(100, Number(process.env.MIN_LIQUIDITY || 10000));
const MIN_VOLUME = Math.max(100, Number(process.env.MIN_VOLUME || 25000));
const TAKE_PROFIT = Math.max(1, Number(process.env.TAKE_PROFIT || 20));
const STOP_LOSS = Math.max(1, Number(process.env.STOP_LOSS || 10));
const MAX_OPEN_POSITIONS = Math.max(1, Number(process.env.MAX_OPEN_POSITIONS || 3));
const SCAN_MS = Math.max(30000, Number(process.env.SCAN_MS || 60000));

let state = loadState();
let scanning = false;
let lastScanAt = null;
let lastStatus = "Server berjalan; menunggu pemindaian pertama.";
let latestTokens = [];

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return { cash: Number(s.cash ?? START_BALANCE), realized: Number(s.realized || 0),
      positions: Array.isArray(s.positions) ? s.positions : [],
      history: Array.isArray(s.history) ? s.history : [] };
  } catch {
    return { cash: START_BALANCE, realized: 0, positions: [], history: [] };
  }
}
function saveState() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error("Gagal menyimpan state:", e.message); }
}
const n = (v) => Number(v || 0);
const label = (p) => p?.baseToken?.symbol || p?.baseToken?.name || "TOKEN";
const now = () => new Date().toISOString();

function addHistory(token, action, price, amount, result = "—") {
  state.history.unshift({ time: now(), token, action, price: n(price), amount: n(amount), result });
  state.history = state.history.slice(0, 300);
}
function markToMarket() {
  const byAddress = new Map(latestTokens.map(p => [p.pairAddress, p]));
  for (const pos of state.positions) {
    const fresh = byAddress.get(pos.pairAddress);
    if (fresh && n(fresh.priceUsd) > 0) {
      pos.price = n(fresh.priceUsd);
      pos.peak = Math.max(n(pos.peak), pos.price);
      pos.tokenName = label(fresh);
    }
  }
}
function closePosition(pos, reason) {
  const price = n(pos.price);
  if (!(price > 0)) return false;
  const proceeds = pos.qty * price;
  const pnl = proceeds - pos.cost;
  state.cash += proceeds;
  state.realized += pnl;
  addHistory(pos.tokenName, reason, price, proceeds, `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USD`);
  state.positions = state.positions.filter(x => x.id !== pos.id);
  return true;
}
function evaluateExits() {
  for (const pos of [...state.positions]) {
    if (!(pos.price > 0 && pos.entry > 0)) continue;
    const pct = (pos.price / pos.entry - 1) * 100;
    if (pct >= TAKE_PROFIT) closePosition(pos, `TAKE PROFIT ${TAKE_PROFIT}% (paper)`);
    else if (pct <= -STOP_LOSS) closePosition(pos, `STOP LOSS -${STOP_LOSS}% (paper)`);
  }
}
function score(p) {
  return n(p.priceChange?.h1) * 0.55 +
    Math.log10(Math.max(1, n(p.volume?.h24))) * 2 +
    Math.log10(Math.max(1, n(p.liquidity?.usd)));
}
function eligible(p) {
  const change = n(p.priceChange?.h1);
  return p.chainId === "solana" && p.pairAddress && n(p.priceUsd) > 0 &&
    n(p.liquidity?.usd) >= MIN_LIQUIDITY && n(p.volume?.h24) >= MIN_VOLUME &&
    change <= 80 && change >= -15;
}
async function getJson(url) {
  const response = await fetch(url, { headers: { "accept": "application/json", "user-agent": "SolanaMemecoinBotV8Paper/1.0" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} dari data API`);
  return response.json();
}
async function scanMarket() {
  if (scanning) return;
  scanning = true;
  try {
    const profiles = await getJson("https://api.dexscreener.com/token-profiles/latest/v1");
    const sol = (Array.isArray(profiles) ? profiles : [])
      .filter(x => x.chainId === "solana" && x.tokenAddress).slice(0, 35);
    const results = await Promise.all(sol.map(async t => {
      try {
        const data = await getJson("https://api.dexscreener.com/token-pairs/v1/solana/" + encodeURIComponent(t.tokenAddress));
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    }));
    const seen = new Set();
    latestTokens = results.flat().filter(p => {
      if (p.chainId !== "solana" || !p.pairAddress || seen.has(p.pairAddress)) return false;
      seen.add(p.pairAddress);
      return n(p.liquidity?.usd) >= MIN_LIQUIDITY && n(p.volume?.h24) >= MIN_VOLUME && n(p.priceUsd) > 0;
    }).sort((a,b) => score(b)-score(a)).slice(0, 100);

    // Paper-only auto entry: only enter candidates within the basic momentum/liquidity filters.
    // This is not a safety guarantee and does not use live wallet credentials.
    const candidates = latestTokens.filter(eligible);
    for (const p of candidates) {
      if (state.positions.length >= MAX_OPEN_POSITIONS) break;
      if (state.positions.some(x => x.pairAddress === p.pairAddress)) continue;
      if (state.cash < POSITION_SIZE) break;
      const price = n(p.priceUsd);
      if (!(price > 0)) continue;
      const cost = POSITION_SIZE;
      const qty = cost / price;
      state.cash -= cost;
      const pos = { id: `${p.pairAddress}-${Date.now()}`, pairAddress: p.pairAddress,
        mint: p.baseToken?.address || "", tokenName: label(p), symbol: p.baseToken?.symbol || "",
        entry: price, price, qty, cost, peak: price, openedAt: now() };
      state.positions.push(pos);
      addHistory(pos.tokenName, "BELI OTOMATIS (paper)", price, cost);
    }
    markToMarket();
    evaluateExits();
    lastScanAt = now();
    lastStatus = `Pemindaian berhasil. ${latestTokens.length} pasangan lolos filter likuiditas/volume; ${candidates.length} kandidat dasar.`;
    saveState();
  } catch (e) {
    lastStatus = `Pemindaian gagal: ${e.message}. Data terakhir dipertahankan.`;
    console.error(lastStatus);
  } finally {
    scanning = false;
  }
}
async function refreshPrices() {
  if (!state.positions.length) return;
  const addresses = [...new Set(state.positions.map(p => p.pairAddress).filter(Boolean))];
  await Promise.all(addresses.map(async address => {
    try {
      const data = await getJson("https://api.dexscreener.com/latest/dex/pairs/solana/" + encodeURIComponent(address));
      const fresh = (data.pairs || []).find(p => p.pairAddress === address) || (data.pairs || [])[0];
      if (fresh && n(fresh.priceUsd) > 0) {
        latestTokens = latestTokens.filter(p => p.pairAddress !== address);
        latestTokens.push(fresh);
        for (const pos of state.positions) {
          if (pos.pairAddress === address) {
            pos.price = n(fresh.priceUsd);
            pos.peak = Math.max(n(pos.peak), pos.price);
            pos.tokenName = label(fresh);
          }
        }
      }
    } catch {}
  }));
  evaluateExits();
  saveState();
}
function summary() {
  markToMarket();
  const openValue = state.positions.reduce((s,p) => s + n(p.price)*n(p.qty), 0);
  const unrealized = state.positions.reduce((s,p) => s + (n(p.price)-n(p.entry))*n(p.qty), 0);
  return { mode: "PAPER ONLY — no live wallet connected", cash: state.cash, openValue,
    equity: state.cash + openValue, realized: state.realized, unrealized,
    positions: state.positions, history: state.history.slice(0,100), tokens: latestTokens.slice(0,40),
    settings: { startBalance: START_BALANCE, positionSize: POSITION_SIZE, minLiquidity: MIN_LIQUIDITY,
      minVolume: MIN_VOLUME, takeProfit: TAKE_PROFIT, stopLoss: STOP_LOSS,
      maxOpenPositions: MAX_OPEN_POSITIONS, scanSeconds: SCAN_MS/1000 },
    lastScanAt, status: lastStatus, scanning };
}
app.get("/api/status", (_req,res) => res.json(summary()));
app.post("/api/scan", async (_req,res) => { await scanMarket(); res.json(summary()); });
app.post("/api/reset", (_req,res) => {
  state = { cash: START_BALANCE, realized: 0, positions: [], history: [] };
  saveState(); res.json(summary());
});
app.get("/health", (_req,res) => res.json({ok:true, time:now()}));

app.listen(PORT, () => {
  console.log(`Solana Memecoin Bot V8 PAPER listening on ${PORT}`);
  scanMarket();
  setInterval(scanMarket, SCAN_MS);
  setInterval(refreshPrices, 15000);
});

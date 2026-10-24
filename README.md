# Solana Memecoin Bot V8 — Cloud Paper Trading

This is a server-hosted **paper-trading prototype** based on the V7.4 idea. It does not connect to Phantom, hold keys, or submit real trades.

## Default paper settings
- Starting balance: USD 100
- Position size: USD 10
- Minimum liquidity: USD 10,000
- Minimum 24h volume: USD 25,000
- Take profit: 20%
- Stop loss: 10%
- Maximum open positions: 3
- Scan interval: 60 seconds
- Position price refresh: 15 seconds

## Run locally
Requires Node.js 18+.
```bash
npm install
npm start
```
Then open `http://localhost:3000`.

## Deploy
Upload these files to a private GitHub repository and deploy that repository as a web service on a host that supports Node.js. Set the start command to `npm start`. The service needs persistent storage if you want paper balances and history to survive redeploys/restarts; without persistent storage, `data.json` may reset.

## Important limitations
- Uses public DexScreener endpoints; API data can be delayed, incomplete, rate-limited, or unavailable.
- This is a demonstration of automated **paper** entries/exits, not a profitable strategy.
- Rug-pull risk screening is not included in the server-side entry rule yet. Liquidity/volume/momentum filters do not make a token safe.
- No live trades, no wallet signing, no private key or seed phrase handling.
- TP/SL are evaluated when the server gets refreshed price data; gaps, slippage, and unavailable liquidity are not modeled.
- Never put a Phantom seed phrase or private key into a website, repository, or hosting environment.

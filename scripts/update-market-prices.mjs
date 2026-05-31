import { readFile, writeFile } from 'node:fs/promises';

const INDEX_PATH = new URL('../index.html', import.meta.url);
const APP_ID = '3678970';
const CURRENCY = process.env.STEAM_CURRENCY || '8';
const DELAY_MS = Number(process.env.PRICE_FETCH_DELAY_MS || 2500);
const LIMIT = Number(process.env.PRICE_FETCH_LIMIT || 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractMarketNames(html) {
  const block = html.match(/const MARKET_NAMES=\{([\s\S]*?)\};/);
  if (!block) throw new Error('MARKET_NAMES block not found');

  const entries = [];
  const pairPattern = /'([^']+)':'([^']+)'/g;
  let match;
  while ((match = pairPattern.exec(block[1]))) {
    entries.push({ jp: match[1], marketName: match[2] });
  }
  if (!entries.length) throw new Error('No MARKET_NAMES entries found');
  return LIMIT > 0 ? entries.slice(0, LIMIT) : entries;
}

async function fetchLowestPrice(marketName) {
  const params = new URLSearchParams({
    appid: APP_ID,
    currency: CURRENCY,
    market_hash_name: marketName,
  });
  const url = `https://steamcommunity.com/market/priceoverview/?${params}`;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'PageTest_repo market price updater',
        'Accept': 'application/json',
      },
    });

    if (response.status === 429 && attempt < 4) {
      await sleep(DELAY_MS * attempt * 3);
      continue;
    }
    if (!response.ok) return 'None';

    const data = await response.json();
    return data?.success && data?.lowest_price ? data.lowest_price : 'None';
  }

  return 'None';
}

function formatPrices(prices) {
  const lines = ['const MARKET_PRICES={'];
  prices.forEach(({ jp, price }, index) => {
    const comma = index === prices.length - 1 ? '' : ',';
    lines.push(`  '${jp}':'${price}'${comma}`);
  });
  lines.push('};');
  return lines.join('\n');
}

function replacePrices(html, pricesBlock) {
  const next = html.replace(/const MARKET_PRICES=\{[\s\S]*?\};/, pricesBlock);
  if (next === html) throw new Error('MARKET_PRICES block not replaced');
  return next;
}

const html = await readFile(INDEX_PATH, 'utf8');
const entries = extractMarketNames(html);
const prices = [];

for (const entry of entries) {
  const price = await fetchLowestPrice(entry.marketName);
  prices.push({ ...entry, price });
  console.log(`${entry.jp} (${entry.marketName}): ${price}`);
  await sleep(DELAY_MS);
}

if (LIMIT > 0) {
  console.log(`PRICE_FETCH_LIMIT=${LIMIT}; index.html was not written.`);
} else {
  await writeFile(INDEX_PATH, replacePrices(html, formatPrices(prices)), 'utf8');
}

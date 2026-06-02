import { readFile, writeFile } from 'node:fs/promises';

const DATA_PATH = new URL('../data/official-market-items.js', import.meta.url);
const APP_ID = '3678970';
const CURRENCY = process.env.STEAM_CURRENCY || '8';
const COUNTRY = process.env.STEAM_COUNTRY || 'JP';
const DELAY_MS = Number(process.env.PRICE_FETCH_DELAY_MS || 3000);
const START = Number(process.env.PRICE_FETCH_START || 0);
const LIMIT = Number(process.env.PRICE_FETCH_LIMIT || 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseData(source) {
  const snapshotMatch = source.match(/window\.OFFICIAL_MARKET_SNAPSHOT=({[\s\S]*?});/);
  const itemsMatch = source.match(/window\.OFFICIAL_MARKET_ITEMS=(\[[\s\S]*\]);\s*$/);
  if (!snapshotMatch || !itemsMatch) throw new Error('official market data blocks not found');
  return {
    snapshot: JSON.parse(snapshotMatch[1]),
    items: JSON.parse(itemsMatch[1]),
  };
}

function formatData(snapshot, items) {
  return `window.OFFICIAL_MARKET_SNAPSHOT=${JSON.stringify(snapshot, null, 2)};\nwindow.OFFICIAL_MARKET_ITEMS=${JSON.stringify(items, null, 2)};\n`;
}

async function fetchLowestPrice(marketName) {
  const params = new URLSearchParams({
    appid: APP_ID,
    currency: CURRENCY,
    country: COUNTRY,
    market_hash_name: marketName,
  });
  const url = `https://steamcommunity.com/market/priceoverview/?${params}`;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'PageTest_repo official market price updater',
        'Accept': 'application/json',
      },
    });

    if (response.status === 429) {
      throw new Error(`Steam rate limit at ${marketName}`);
    }
    if (!response.ok) return 'None';

    const data = await response.json();
    return data?.success && data?.lowest_price ? data.lowest_price : 'None';
  }

  return 'None';
}

function jstTimestamp() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' +09:00');
}

const source = await readFile(DATA_PATH, 'utf8');
const { snapshot, items } = parseData(source);
const end = LIMIT > 0 ? Math.min(items.length, START + LIMIT) : items.length;

for (let index = START; index < end; index += 1) {
  const item = items[index];
  item.price = await fetchLowestPrice(item.marketName);
  console.log(`${index + 1}/${items.length} ${item.marketName}: ${item.price}`);

  snapshot.fetchedAt = jstTimestamp();
  snapshot.priceCurrency = CURRENCY === '8' ? 'JPY' : String(CURRENCY);
  await writeFile(DATA_PATH, formatData(snapshot, items), 'utf8');
  await sleep(DELAY_MS);
}

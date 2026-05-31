import fs from 'node:fs';
import path from 'node:path';

const DATA_FILE = path.join('data', 'equipment-market-data.js');
const PREFIX = 'window.EQUIPMENT_MARKET=';
const SUFFIX = ';\n';
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const SLEEP_MS = Number(process.env.SLEEP_MS || 350);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readEquipment() {
  const text = fs.readFileSync(DATA_FILE, 'utf8');
  if (!text.startsWith(PREFIX)) throw new Error('equipment data prefix not found');
  return JSON.parse(text.slice(PREFIX.length, text.lastIndexOf(';')));
}

function writeEquipment(items) {
  fs.writeFileSync(DATA_FILE, PREFIX + JSON.stringify(items, null, 2) + SUFFIX, 'utf8');
}

function cleanBbcode(value) {
  return String(value || '')
    .replace(/\[\/?(?:b|i|u)\]/gi, '')
    .replace(/\[color=[^\]]+\]/gi, '')
    .replace(/\[\/color\]/gi, '')
    .replace(/\r/g, '')
    .trim();
}

function parseStats(description) {
  const lines = cleanBbcode(description)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const result = { baseStats: [], inherentStats: [], slots: [], requires: '' };
  let section = '';
  for (const line of lines) {
    if (/^Base Stats$/i.test(line)) {
      section = 'baseStats';
      continue;
    }
    if (/^Inherent Stats$/i.test(line)) {
      section = 'inherentStats';
      continue;
    }
    if (/Grade$/i.test(line)) {
      section = '';
      continue;
    }
    if (/^Requires Lv\./i.test(line)) {
      result.requires = line.replace(/^Requires /i, '');
      section = '';
      continue;
    }
    if (/Slot ×\d+/i.test(line)) {
      result.slots.push(line);
      section = '';
      continue;
    }
    if (section && line.startsWith('- ')) {
      result[section].push(line.slice(2));
    }
  }
  return result;
}

function fallbackSlots(rarity) {
  if (rarity === 'Rare') return ['Decoration Slot ×1'];
  if (rarity === 'Legendary') return ['Decoration Slot ×2'];
  if (rarity === 'Immortal') return ['Decoration Slot ×2', 'Engraving Slot ×1'];
  if (['Arcana', 'Beyond', 'Celestial', 'Cosmic', 'Divine'].includes(rarity)) {
    return ['Decoration Slot ×2', 'Engraving Slot ×1', 'Inscription Slot ×1'];
  }
  return [];
}

function findDescription(queryData, marketName) {
  let found = null;
  function walk(value) {
    if (!value || typeof value !== 'object' || found) return;
    if (value.market_hash_name === marketName && Array.isArray(value.descriptions)) {
      found = value.descriptions.map(x => x.value || '').join('\n');
      return;
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(queryData);
  return found;
}

async function fetchItemStats(item) {
  const url = `https://steamcommunity.com/market/listings/3678970/${encodeURIComponent(item.marketName)}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (response.ok) {
      const html = await response.text();
      const match = html.match(/window\.SSR\.renderContext=JSON\.parse\("([\s\S]*?)"\);/);
      if (!match) throw new Error(`SSR data not found: ${item.marketName}`);
      const context = JSON.parse(JSON.parse(`"${match[1]}"`));
      const queryData = JSON.parse(context.queryData);
      const description = findDescription(queryData, item.marketName);
      if (!description) {
        const waitMs = 3000 * (attempt + 1);
        console.log(`retry no-description ${item.marketName} in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      return parseStats(description);
    }
    const waitMs = response.status === 429 ? 15000 * (attempt + 1) : 5000 * (attempt + 1);
    console.log(`retry ${response.status} ${item.marketName} in ${waitMs}ms`);
    await sleep(waitMs);
  }
  throw new Error(`failed to fetch: ${item.marketName}`);
}

async function main() {
  const items = readEquipment();
  const missing = items.filter(item => item.statSource || !Array.isArray(item.baseStats) || item.baseStats.length === 0 || !Array.isArray(item.inherentStats) || !Array.isArray(item.slots));
  console.log(`missing ${missing.length} / ${items.length}`);

  let updated = 0;
  let cursor = 0;
  async function worker(workerId) {
    while (cursor < missing.length) {
      const item = missing[cursor++];
      try {
        const stats = await fetchItemStats(item);
        Object.assign(item, stats);
        if (!stats.statSource) delete item.statSource;
      } catch (error) {
        console.log(`skip ${item.marketName}: ${error.message}`);
        Object.assign(item, { baseStats: [], inherentStats: [], slots: fallbackSlots(item.rarity), requires: item.level ? `Lv.${item.level}` : '', statSource: 'fetch-error' });
      }
      updated++;
      if (updated % 25 === 0) {
        writeEquipment(items);
        console.log(`updated ${updated} / ${missing.length}`);
      }
      await sleep(SLEEP_MS + workerId * 75);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, index) => worker(index)));
  writeEquipment(items);
  console.log(`done ${updated}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

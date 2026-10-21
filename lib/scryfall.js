const fs = require('fs');
const path = require('path');

const API = 'https://api.scryfall.com';
const UA = 'mtg-mesa-commander/1.0 (local personal deck simulator)';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function scryfallGet(urlPath) {
  const res = await fetch(API + urlPath, {
    headers: { 'User-Agent': UA, Accept: 'application/json' }
  });
  if (res.status === 404) return null;
  if (res.status === 429) {
    await sleep(1100);
    return scryfallGet(urlPath);
  }
  if (!res.ok) throw new Error(`Scryfall ${res.status} em ${urlPath}`);
  return res.json();
}

function producesFromCard(card) {
  const texts = [];
  if (card.oracle_text) texts.push(card.oracle_text);
  if (card.card_faces) for (const f of card.card_faces) if (f.oracle_text) texts.push(f.oracle_text);
  const produces = [];
  for (const text of texts) {
    const addRe = /Add\s+([^\.\n]+)/g;
    let m;
    while ((m = addRe.exec(text))) {
      const syms = m[1].match(/\{([WUBRGC])\}/g);
      if (syms) for (const s of syms) {
        const c = s[1];
        if (!produces.includes(c)) produces.push(c);
      }
    }
  }
  if (/Basic Land/i.test(card.type_line || '')) {
    const name = (card.name || '').split(' // ')[0];
    const basicColors = { Forest: 'G', Mountain: 'R', Island: 'U', Plains: 'W', Swamp: 'B', Wastes: 'C' };
    if (basicColors[name] && !produces.includes(basicColors[name])) produces.push(basicColors[name]);
  }
  return produces;
}

function normalizeCard(card) {
  const faces = card.card_faces || [];
  const mana = card.mana_cost || (faces[0] && faces[0].mana_cost) || null;
  const oracle = card.oracle_text || faces.map((f) => f.oracle_text || '').join('\n---\n') || null;
  const typeLine = card.type_line || (faces[0] && faces[0].type_line) || null;
  return {
    name: card.name,
    mana_cost: mana,
    cmc: card.cmc,
    colors: card.colors || [],
    color_identity: card.color_identity || [],
    type_line: typeLine,
    oracle_text: oracle,
    produces: producesFromCard(card)
  };
}

const NAME_VARIANTS = (name) => {
  const out = [];
  const push = (n) => { if (n && !out.includes(n)) out.push(n); };
  push(name);
  push(name.replace(/ -- /g, ' // '));
  push(name.replace(/ \/\/ /g, ' -- '));
  push(name.replace(/[’‘]/g, "'"));
  push(name.replace(/'/g, '’'));
  push(name.replace(/(-{2})/g, '//'));
  return out;
};

async function lookupCard(name) {
  for (const variant of NAME_VARIANTS(name)) {
    const card = await scryfallGet('/cards/named?exact=' + encodeURIComponent(variant));
    if (card) return card;
  }
  const auto = await scryfallGet('/cards/autocomplete?q=' + encodeURIComponent(name));
  if (auto && auto.data && auto.data.length) {
    const best = auto.data[0];
    const card = await scryfallGet('/cards/named?exact=' + encodeURIComponent(best.name));
    if (card) return card;
  }
  return null;
}

function readDb(dataDir) {
  const file = path.join(dataDir, 'cards-db.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeDb(dataDir, db) {
  fs.writeFileSync(path.join(dataDir, 'cards-db.json'), JSON.stringify(db, null, 1));
}

async function fetchMissing(names, dataDir, { delayMs = 150, onProgress = () => {} } = {}) {
  const db = readDb(dataDir);
  const missing = names.filter((n) => !db[n]);
  let done = 0;
  const failed = [];
  for (const name of missing) {
    try {
      const card = await lookupCard(name);
      if (card) {
        db[name] = normalizeCard(card);
        db[name].scryName = card.name;
      } else {
        failed.push(name);
      }
    } catch (e) {
      failed.push(name);
    }
    done++;
    writeDb(dataDir, db);
    onProgress({ done, total: missing.length, name, failed: [...failed] });
    if (delayMs) await sleep(delayMs);
  }
  return { db, fetched: done, failed };
}

module.exports = { fetchMissing, readDb, writeDb, lookupCard, normalizeCard };

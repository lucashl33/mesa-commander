const fs = require('fs');
const path = require('path');

function sniffJpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function sniffPngSize(buf) {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function imageSize(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, 65536, 0);
    const b = buf.subarray(0, n);
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return sniffJpegSize(b);
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return sniffPngSize(b);
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

const CARD_RATIO_MIN = 0.69;
const CARD_RATIO_MAX = 0.74;

function isCardShaped(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png') return false;
  const size = imageSize(filePath);
  if (!size) return false;
  const ratio = size.w / size.h;
  return ratio >= CARD_RATIO_MIN && ratio <= CARD_RATIO_MAX && size.w >= 300 && size.h >= 400;
}

function listImageFiles(dir, depth = 0, maxDepth = 3) {
  const out = [];
  if (depth > maxDepth) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listImageFiles(full, depth + 1, maxDepth));
    else if (/\.(jpe?g|png)$/i.test(e.name)) out.push(full);
  }
  return out;
}

function cardCountIn(dir, depth = 0) {
  if (depth > 1) return { total: 0, cards: 0 };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { total: 0, cards: 0 };
  }
  let total = 0;
  let cards = 0;
  let sampled = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isFile() && /\.(jpe?g|png)$/i.test(e.name)) {
      total++;
      if (sampled < 12) {
        sampled++;
        if (isCardShaped(full)) cards++;
      }
    } else if (e.isDirectory() && depth < 1) {
      const sub = cardCountIn(full, depth + 1);
      total += sub.total;
      cards += sub.cards;
    }
  }
  return { total, cards };
}

function isUnder(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function scanDecks(vaultRoot) {
  const results = [];
  const stack = [{ dir: vaultRoot, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > 6) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let directCards = 0;
    let subfolderCards = 0;
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
        if (depth < 5) {
          const sub = cardCountIn(full, 1);
          if (sub.total >= 5 && sub.cards / Math.max(1, sub.total) >= 0.6) subfolderCards++;
        }
      } else if (/\.(jpe?g|png)$/i.test(e.name)) {
        directCards++;
      }
    }
    if (dir !== vaultRoot && (directCards >= 5 || subfolderCards >= 1)) {
      const files = listImageFiles(dir, 0, 1);
      let sampled = 0;
      let cards = 0;
      for (const f of files) {
        if (sampled >= 12) break;
        sampled++;
        if (isCardShaped(f)) cards++;
      }
      const qualifies = files.length >= 5 && sampled > 0 && cards / sampled >= 0.6;
      if (qualifies) {
        results.push({
          relPath: path.relative(vaultRoot, dir),
          name: path.basename(dir),
          cardFiles: files.length
        });
      }
    }
  }
  results.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const kept = [];
  for (const cand of results) {
    const candAbs = path.join(vaultRoot, cand.relPath);
    const isDescendant = kept.some((k) => isUnder(path.join(vaultRoot, k.relPath), candAbs));
    if (!isDescendant) kept.push(cand);
  }
  return kept;
}

const CATEGORY_RULES = [
  { re: /criatura|creature/i, typeClass: 'creature' },
  { re: /terreno|land/i, also: /norma|basico|basic/i, typeClass: 'basic-land' },
  { re: /terreno|land/i, typeClass: 'land' },
  { re: /instant/i, typeClass: 'instant' },
  { re: /feitico|sorcery/i, typeClass: 'sorcery' },
  { re: /artefato|artifact|enchant|aura/i, typeClass: 'artifact' },
  { re: /comandante|commander/i, typeClass: 'creature' }
];

function classifyFromCategory(category) {
  if (!category) return 'card';
  const norm = category.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(norm) && (!rule.also || rule.also.test(norm))) return rule.typeClass;
  }
  return 'card';
}

function cleanCardName(fileName) {
  let name = fileName.replace(/\.(jpe?g|png)$/i, '');
  const m = name.match(/^(\d+)_COMMANDER_(.+)$/i);
  if (m) return { name: m[2], isCommander: true };
  return { name, isCommander: false };
}

function typeFromMetadata(template, metadata) {
  if (!metadata || !metadata.type_line) return null;
  const t = metadata.type_line;
  if (/Basic Land/i.test(t)) return 'basic-land';
  if (/Land/i.test(t)) return 'land';
  if (/Instant/i.test(t)) return 'instant';
  if (/Sorcery/i.test(t)) return 'sorcery';
  if (/Creature/i.test(t)) return 'creature';
  if (/Enchantment/i.test(t)) return 'enchantment';
  if (/Artifact/i.test(t)) return 'artifact';
  return 'card';
}

function loadDeck(vaultRoot, relPath, cardDb = {}) {
  const abs = path.resolve(vaultRoot, relPath);
  if (!abs.startsWith(path.resolve(vaultRoot))) throw new Error('Caminho fora do cofre');
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    throw new Error('Pasta do deck nao encontrada: ' + relPath);
  }
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(abs, e.name);
    if (e.isFile() && /\.(jpe?g|png)$/i.test(e.name)) {
      files.push({ full, rel: e.name, category: '' });
    } else if (e.isDirectory()) {
      let subs;
      try {
        subs = fs.readdirSync(full, { withFileTypes: true });
      } catch { continue; }
      for (const s of subs) {
        if (s.name.startsWith('.')) continue;
        if (s.isFile() && /\.(jpe?g|png)$/i.test(s.name)) {
          files.push({ full: path.join(full, s.name), rel: path.join(e.name, s.name), category: e.name });
        }
      }
    }
  }
  if (!files.length) throw new Error('Nenhuma imagem de carta em: ' + relPath);

  const templates = [];
  let commander = null;
  for (const f of files) {
    const { name, isCommander } = cleanCardName(f.rel.split(path.sep).pop());
    const meta = cardDb[name] || null;
    const typeClass = typeFromMetadata(null, meta) || classifyFromCategory(f.category);
    const tpl = {
      key: name,
      name,
      file: f.rel,
      category: f.category,
      typeClass,
      meta,
      scryName: meta ? (meta.scryName || meta.name) : null
    };
    if (isCommander) {
      tpl.isCommander = true;
      commander = tpl;
    }
    const existing = templates.find((t) => t.key === tpl.key);
    if (!existing) templates.push(tpl);
    else if (isCommander) existing.isCommander = true;
  }
  if (!commander) {
    const cand = templates.find((t) => /legendary creature/i.test((cardDb[t.key] || {}).type_line || ''));
    if (cand) {
      cand.isCommander = true;
      commander = cand;
    }
  }
  return {
    id: relPath,
    name: path.basename(abs),
    path: abs,
    commanderKey: commander ? commander.key : null,
    cards: templates,
    cardCount: files.length
  };
}

function readRegistry(dataDir) {
  const file = path.join(dataDir, 'decks.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function writeRegistry(dataDir, entries) {
  const file = path.join(dataDir, 'decks.json');
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
}

function upsertRegistry(dataDir, entry) {
  const entries = readRegistry(dataDir);
  const idx = entries.findIndex((e) => e.relPath === entry.relPath);
  if (idx >= 0) entries[idx] = { ...entries[idx], ...entry };
  else entries.push(entry);
  entries.sort((a, b) => (b.lastLoadedAt || 0) - (a.lastLoadedAt || 0));
  writeRegistry(dataDir, entries);
  return entries;
}

function suggestBasicCopies(deck) {
  const basics = deck.cards.filter((c) => c.typeClass === 'basic-land');
  const nonBasicSlots = deck.cardCount;
  const extras = Math.max(0, 100 - nonBasicSlots);
  const copies = {};
  if (!basics.length) return { copies, extras, needed: extras };
  const names = basics.map((b) => b.name);
  const base = Math.floor(extras / names.length);
  let rest = extras % names.length;
  for (const n of names) {
    copies[n] = base + (rest > 0 ? 1 : 0);
    if (rest > 0) rest--;
  }
  return { copies, extras, needed: extras };
}

module.exports = {
  scanDecks,
  loadDeck,
  readRegistry,
  writeRegistry,
  upsertRegistry,
  suggestBasicCopies,
  isCardShaped,
  cleanCardName,
  classifyFromCategory
};

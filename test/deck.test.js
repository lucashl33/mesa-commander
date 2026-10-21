const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanDecks, loadDeck, isCardShaped, suggestBasicCopies, cleanCardName } = require('../lib/deck');

function makeJpeg(w, h) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]),
    Buffer.from([0xff, 0xd9])
  ]);
}

function writeCards(dir, count, w = 488, h = 680) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(dir, `Card ${i}.jpg`), makeJpeg(w, h));
  }
}

let tmpRoot;

function buildFixture() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-deck-'));
  writeCards(path.join(tmpRoot, 'A00 Particular/RPG/Deck-Commander-Test/1 Criaturas'), 6);
  writeCards(path.join(tmpRoot, 'A00 Particular/RPG/Deck-Commander-Test/2 Terrenos normais'), 2);
  writeCards(path.join(tmpRoot, 'Screenshots'), 6, 1920, 1080);
  writeCards(path.join(tmpRoot, 'Fotos'), 6, 3024, 4032);
  return tmpRoot;
}

test('isCardShaped reconhece formato de carta e rejeita screenshot/foto', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-shape-'));
  const card = path.join(dir, 'card.jpg');
  const shot = path.join(dir, 'shot.jpg');
  const photo = path.join(dir, 'photo.jpg');
  fs.writeFileSync(card, makeJpeg(488, 680));
  fs.writeFileSync(shot, makeJpeg(1920, 1080));
  fs.writeFileSync(photo, makeJpeg(3024, 4032));
  assert.equal(isCardShaped(card), true);
  assert.equal(isCardShaped(shot), false);
  assert.equal(isCardShaped(photo), false);
});

test('scanDecks acha decks e descarta pastas de imagem comum', () => {
  const root = buildFixture();
  const found = scanDecks(root);
  const rels = found.map((f) => f.relPath);
  assert.ok(rels.includes(path.join('A00 Particular/RPG/Deck-Commander-Test')),
    'deck com subpastas deve aparecer: ' + JSON.stringify(rels));
  assert.ok(!rels.some((r) => r.includes('Criaturas')), 'subpasta do deck não deve aparecer');
  assert.ok(!rels.some((r) => r.includes('Screenshots')), 'screenshots não devem aparecer');
  assert.ok(!rels.some((r) => r.includes('Fotos')), 'fotos não devem aparecer');
});

test('loadDeck monta templates, detecta comandante e classifica tipos', () => {
  const root = buildFixture();
  const deckDir = path.join(root, 'A00 Particular/RPG/Deck-Commander-Test');
  fs.writeFileSync(path.join(deckDir, '1 Criaturas/00_COMMANDER_Test Hero.jpg'), makeJpeg(488, 680));
  fs.writeFileSync(path.join(deckDir, "1 Criaturas/Gandalf, Goblins' Bane -- Flameshape.jpg"), makeJpeg(488, 680));
  fs.mkdirSync(path.join(deckDir, '5 Feitiços'), { recursive: true });
  fs.writeFileSync(path.join(deckDir, '5 Feitiços/Cultivate.jpg'), makeJpeg(488, 680));

  const rel = path.join('A00 Particular/RPG/Deck-Commander-Test');
  const deck = loadDeck(root, rel, {
    'Test Hero': { name: 'Test Hero', type_line: 'Legendary Creature — Human', produces: [], scryName: 'Test Hero' }
  });
  assert.equal(deck.commanderKey, 'Test Hero');
  const hero = deck.cards.find((c) => c.key === 'Test Hero');
  assert.equal(hero.isCommander, true);
  assert.equal(hero.typeClass, 'creature');
  const cult = deck.cards.find((c) => c.key === 'Cultivate');
  assert.equal(cult.typeClass, 'sorcery');
  assert.equal(cult.scryName, null);
  const gandalf = deck.cards.find((c) => c.key === "Gandalf, Goblins' Bane -- Flameshape");
  assert.ok(gandalf, 'carta com -- no nome deve ser lida');
  assert.ok(deck.cardCount >= 9);
});

test('cleanCardName entende prefixo 00_COMMANDER_', () => {
  assert.deepEqual(cleanCardName('00_COMMANDER_Strider, Ranger of the North.jpg'),
    { name: 'Strider, Ranger of the North', isCommander: true });
  assert.deepEqual(cleanCardName('Sol Ring.jpg'), { name: 'Sol Ring', isCommander: false });
});

test('suggestBasicCopies fecha o deck em 100 cartas', () => {
  const deck = {
    cardCount: 81,
    commanderKey: 'Strider',
    cards: [
      { name: 'Forest', typeClass: 'basic-land' },
      { name: 'Mountain', typeClass: 'basic-land' }
    ]
  };
  const s = suggestBasicCopies(deck);
  assert.equal(s.extras, 19);
  assert.equal(s.copies.Forest + s.copies.Mountain, 19);
  const noBasics = suggestBasicCopies({ cardCount: 60, commanderKey: 'X', cards: [] });
  assert.equal(noBasics.extras, 40);
  assert.deepEqual(noBasics.copies, {});
});

test('deck do Strider real carrega com 80 cartas e comandante', (t) => {
  const vault = process.env.MTG_TEST_VAULT || path.join(os.homedir(), 'Documents/Meu Cofre');
  if (!fs.existsSync(vault)) return t.skip('cofre de exemplo não encontrado (defina MTG_TEST_VAULT)');
  const deckPath = path.join('A00 Particular/RPG/Deck-Commander-Strider');
  if (!fs.existsSync(path.join(vault, deckPath))) return t.skip('deck de exemplo não encontrado');
  const deck = loadDeck(vault, deckPath);
  assert.equal(deck.cardCount, 81);
  assert.equal(deck.commanderKey, 'Strider, Ranger of the North');
  const types = {};
  for (const c of deck.cards) types[c.typeClass] = (types[c.typeClass] || 0) + 1;
  assert.ok(types.creature >= 30, 'deve haver ~31 criaturas');
  assert.ok(types['basic-land'] >= 2, 'básicos detectados');
});

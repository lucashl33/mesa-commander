const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

function makeJpeg(w, h) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]),
    Buffer.from([0xff, 0xd9])
  ]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-vault-'));
  const deckDir = path.join(root, 'Decks/Deck-Teste');
  fs.mkdirSync(path.join(deckDir, '1 Criaturas'), { recursive: true });
  fs.mkdirSync(path.join(deckDir, '2 Terrenos normais'), { recursive: true });
  const db = {};
  fs.writeFileSync(path.join(deckDir, '1 Criaturas/00_COMMANDER_Hero.jpg'), makeJpeg(488, 680));
  db.Hero = { name: 'Hero', mana_cost: '{1}{G}', cmc: 2, colors: ['G'], color_identity: ['G'], type_line: 'Legendary Creature — Human', oracle_text: '', produces: [], scryName: 'Hero' };
  for (let i = 0; i < 7; i++) {
    fs.writeFileSync(path.join(deckDir, `1 Criaturas/Criatura ${i}.jpg`), makeJpeg(488, 680));
    db[`Criatura ${i}`] = { name: `Criatura ${i}`, mana_cost: '{1}{G}', cmc: 2, colors: ['G'], color_identity: ['G'], type_line: 'Creature — Elf', oracle_text: '', produces: [], scryName: `Criatura ${i}` };
  }
  fs.writeFileSync(path.join(deckDir, '2 Terrenos normais/Forest.jpg'), makeJpeg(488, 680));
  fs.writeFileSync(path.join(deckDir, '2 Terrenos normais/Mountain.jpg'), makeJpeg(488, 680));
  db.Forest = { name: 'Forest', mana_cost: null, cmc: 0, colors: [], color_identity: ['G'], type_line: 'Basic Land — Forest', oracle_text: '', produces: ['G'], scryName: 'Forest' };
  db.Mountain = { name: 'Mountain', mana_cost: null, cmc: 0, colors: [], color_identity: ['R'], type_line: 'Basic Land — Mountain', oracle_text: '', produces: ['R'], scryName: 'Mountain' };

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-data-'));
  fs.writeFileSync(path.join(dataDir, 'cards-db.json'), JSON.stringify(db));
  return { root, dataDir };
}

function mkClient(url) {
  const msgs = [];
  let cursor = 0;
  const ws = new WebSocket(url);
  const open = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  return {
    ws,
    open,
    async waitFor(pred, ms = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        for (; cursor < msgs.length; cursor++) {
          if (pred(msgs[cursor])) {
            const m = msgs[cursor];
            cursor++;
            return m;
          }
        }
        await sleep(20);
      }
      throw new Error('timeout. mensagens: ' + msgs.map((m) => m.t).join(','));
    },
    close() { try { ws.close(); } catch {} }
  };
}

test('servidor: carregar deck, sincronizar mesa e mão por WebSocket', async (t) => {
  const { root, dataDir } = buildFixture();
  const port = 3200 + Math.floor(Math.random() * 400);
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), VAULT_ROOT: root, MTG_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });

  t.after(() => { try { proc.kill('SIGKILL'); } catch {} });

  let up = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/info`);
      if (r.ok) { up = true; break; }
    } catch {}
    await sleep(50);
  }
  assert.ok(up, 'servidor subiu. log: ' + out);

  const base = `http://127.0.0.1:${port}`;
  const info = await (await fetch(base + '/api/info')).json();
  assert.equal(info.vaultRoot, root);

  const hand = mkClient(`ws://127.0.0.1:${port}/ws?role=hand`);
  const table = mkClient(`ws://127.0.0.1:${port}/ws?role=table`);
  await Promise.all([hand.open, table.open]);

  const helloHand = await hand.waitFor((m) => m.t === 'hello');
  assert.equal(helloHand.role, 'hand');
  assert.equal(helloHand.hasGame, false);
  assert.equal(helloHand.view, undefined);

  const load = await (await fetch(base + '/api/decks/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relPath: path.join('Decks/Deck-Teste'), basicCopies: { Forest: 45, Mountain: 46 } })
  })).json();
  assert.ok(load.ok, JSON.stringify(load));
  assert.equal(load.deck.commanderKey, 'Hero');

  const sHand = await hand.waitFor((m) => m.t === 'state' && m.view && m.view.stage === 'mulligan');
  const sTable = await table.waitFor((m) => m.t === 'state' && m.view && m.view.stage === 'mulligan');
  assert.equal(sHand.view.players.p1.zones.hand.length, 7);
  assert.equal(sTable.view.players.p1.zones.hand.length, 7);
  assert.equal(sHand.view.players.p1.zones.library, undefined, 'ordem da biblioteca não vai ao cliente');
  assert.equal(typeof sHand.view.players.p1.zones.libraryCount, 'number');
  assert.equal(sHand.view.cards[sHand.view.players.p1.zones.command[0]].tpl, 'Hero');

  const post = async (action) => (await fetch(base + '/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action)
  })).json();

  let r = await post({ t: 'mulligan', choice: 'keep' });
  assert.ok(r.ok);
  await hand.waitFor((m) => m.t === 'state' && m.view.stage === 'play');
  await table.waitFor((m) => m.t === 'state' && m.view.stage === 'play');

  r = await post({ t: 'draw' });
  assert.ok(r.ok);
  const drawn = await hand.waitFor((m) => m.t === 'state' && m.view.stage === 'play' && m.view.players.p1.zones.hand.length === 8);
  assert.equal(drawn.view.players.p1.zones.hand.length, 8);
  const tDrawn = await table.waitFor((m) => m.t === 'state' && m.view.stage === 'play' && m.view.players.p1.zones.hand.length === 8);
  assert.equal(tDrawn.view.players.p1.zones.hand.length, 8, 'mesa e mão sincronizadas');

  const cardUid = drawn.view.players.p1.zones.hand.find((uid) => drawn.view.cards[uid].tpl === 'Forest') || drawn.view.players.p1.zones.hand[0];
  r = await post({ t: 'move', uid: cardUid, to: 'battlefield' });
  assert.ok(r.ok);
  const bf = await hand.waitFor((m) => m.t === 'state' && m.view.players.p1.zones.battlefield.length === 1);
  assert.equal(bf.view.players.p1.zones.battlefield[0], cardUid);

  r = await post({ t: 'undo' });
  assert.ok(r.ok);
  await hand.waitFor((m) => m.t === 'state' && m.view.players.p1.zones.battlefield.length === 0);

  hand.close();
  table.close();
});

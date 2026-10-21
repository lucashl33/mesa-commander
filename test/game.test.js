const test = require('node:test');
const assert = require('node:assert');
const { createGame, apply, view, PHASES } = require('../lib/game');

function fakeDeck() {
  const cards = [];
  cards.push({ key: 'Strider', name: 'Strider, Ranger of the North', file: '00_COMMANDER_Strider.jpg', category: '1 Criaturas', typeClass: 'creature', isCommander: true, scryName: null, meta: { produces: [] } });
  for (let i = 0; i < 15; i++) {
    cards.push({ key: 'Creature ' + i, name: 'Creature ' + i, file: 'c' + i + '.jpg', category: '1 Criaturas', typeClass: 'creature', scryName: null, meta: { produces: [] } });
  }
  cards.push({ key: 'Forest', name: 'Forest', file: 'Forest.jpg', category: '2 Terrenos normais', typeClass: 'basic-land', scryName: null, meta: { produces: ['G'] } });
  cards.push({ key: 'Mountain', name: 'Mountain', file: 'Mountain.jpg', category: '2 Terrenos normais', typeClass: 'basic-land', scryName: null, meta: { produces: ['R'] } });
  cards.push({ key: 'Sol Ring', name: 'Sol Ring', file: 'Sol Ring.jpg', category: '6 Artefatos', typeClass: 'artifact', scryName: null, meta: { produces: [] } });
  return { id: 'test', name: 'Deck Test', commanderKey: 'Strider', cards, cardCount: 18 };
}

function libCount(s) { return s.players.p1.zones.library.length; }
function handCount(s) { return s.players.p1.zones.hand.length; }

test('criação do jogo: mão de 7, comandante no comando, deck embaralhado', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: { Forest: 40, Mountain: 41 } });
  assert.equal(s.stage, 'mulligan');
  assert.equal(handCount(s), 7);
  assert.equal(s.players.p1.zones.command.length, 1);
  assert.equal(s.cards[s.players.p1.zones.command[0]].tpl, 'Strider');
  assert.equal(libCount(s), 92);
  assert.equal(Object.keys(s.cards).length, 100);
  assert.equal(s.mulligan.count, 0);
  assert.equal(s.players.p1.life, 40);
});

test('mulligan de Londras: manter direto, mulligan e fundo de N cartas', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: { Forest: 40, Mountain: 41 } });
  let r = apply(s, { t: 'mulligan', choice: 'again' });
  assert.ok(r.ok);
  assert.equal(s.mulligan.count, 1);
  assert.equal(handCount(s), 7);
  assert.equal(libCount(s), 92);
  r = apply(s, { t: 'mulligan', choice: 'again' });
  assert.equal(s.mulligan.count, 2);
  r = apply(s, { t: 'mulligan', choice: 'keep' });
  assert.ok(r.ok);
  assert.equal(s.mulligan.phase, 'bottom');
  r = apply(s, { t: 'mulliganBottom', uids: [s.players.p1.zones.hand[0]] });
  assert.equal(r.ok, false, 'precisa de 2 cartas, não 1');
  const picks = s.players.p1.zones.hand.slice(0, 2);
  r = apply(s, { t: 'mulliganBottom', uids: picks });
  assert.ok(r.ok);
  assert.equal(handCount(s), 5);
  assert.equal(libCount(s), 94);
  assert.equal(s.stage, 'play');
  assert.equal(s.mulligan, null);
});

test('keep sem mulligan vai direto ao jogo', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: { Forest: 80, Mountain: 17 } });
  apply(s, { t: 'mulligan', choice: 'keep' });
  assert.equal(s.stage, 'play');
  assert.equal(handCount(s), 7);
});

test('comprar carta e deck vazio gera flag', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: {} });
  apply(s, { t: 'mulligan', choice: 'keep' });
  const before = handCount(s);
  apply(s, { t: 'draw' });
  assert.equal(handCount(s), before + 1);
  s.players.p1.zones.library = [];
  apply(s, { t: 'draw' });
  assert.ok(s.flags.some((f) => f.type === 'deckout'));
});

test('avanço de fases: untap limpa viradas/sickness, turno 1 não compra, turno 2 compra', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: { Forest: 80, Mountain: 17 } });
  apply(s, { t: 'mulligan', choice: 'keep' });
  for (let i = 0; i < PHASES.length; i++) apply(s, { t: 'advancePhase' });
  assert.equal(s.turn, 2, 'cleanup → untap vira turno');
  assert.equal(s.phaseIdx, 0);
  const hand = handCount(s);
  apply(s, { t: 'advancePhase' });
  assert.equal(s.phaseIdx, 1);
  apply(s, { t: 'advancePhase' });
  assert.equal(s.phaseIdx, 2, 'draw step do turno 2');
  assert.equal(handCount(s), hand + 1, 'comprou no turno 2');
});

test('turno 1 não compra automaticamente no draw step', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: { Forest: 80, Mountain: 17 } });
  apply(s, { t: 'mulligan', choice: 'keep' });
  const hand = handCount(s);
  apply(s, { t: 'setPhase', idx: PHASES.indexOf('draw') });
  assert.equal(handCount(s), hand, 'sem compra no turno 1');
  assert.ok(s.log.some((l) => l.m.includes('Turno 1')));
});

test('mover terreno para o campo: sickness, limpa no untap, aviso de 2º terreno', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: {} });
  apply(s, { t: 'mulligan', choice: 'keep' });
  const uid = s.players.p1.zones.hand[0];
  s.players.p1.zones.hand = [uid, ...s.players.p1.zones.hand.slice(1)];
  for (const u of s.players.p1.zones.hand) s.cards[u].tpl = 'Forest';
  apply(s, { t: 'move', uid, to: 'battlefield' });
  assert.ok(s.players.p1.zones.battlefield.includes(uid));
  assert.equal(s.cards[uid].sick, true);
  assert.equal(s.players.p1.landPlayed, true);
  const uid2 = s.players.p1.zones.hand[1];
  apply(s, { t: 'move', uid: uid2, to: 'battlefield' });
  assert.ok(s.flags.some((f) => f.type === 'landdrop'), 'aviso de segundo terreno');
  s.cards[uid].tapped = true;
  apply(s, { t: 'advancePhase', });
  for (let i = 0; i < PHASES.length - 1; i++) apply(s, { t: 'advancePhase' });
  assert.equal(s.cards[uid].tapped, false, 'desvirou no untap');
  assert.equal(s.cards[uid].sick, false, 'sickness limpa no untap');
  assert.equal(s.players.p1.landPlayed, false, 'pode jogar terreno de novo');
});

test('tap toggle e desvirar tudo', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: {} });
  apply(s, { t: 'mulligan', choice: 'keep' });
  const a = 'c10', b = 'c11';
  apply(s, { t: 'move', uid: a, to: 'battlefield' });
  apply(s, { t: 'move', uid: b, to: 'battlefield' });
  apply(s, { t: 'tapToggle', uid: a });
  assert.equal(s.cards[a].tapped, true);
  apply(s, { t: 'tapToggle', uid: a });
  assert.equal(s.cards[a].tapped, false);
  apply(s, { t: 'tapToggle', uid: a });
  apply(s, { t: 'untapAll' });
  assert.equal(s.cards[a].tapped, false);
});

test('comandante: conjurar, taxa crescente e volta à zona de comando', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: {} });
  apply(s, { t: 'mulligan', choice: 'keep' });
  const cmdUid = s.players.p1.zones.command[0];
  apply(s, { t: 'castCommander' });
  assert.equal(s.players.p1.cmdCasts, 1);
  assert.ok(s.players.p1.zones.battlefield.includes(cmdUid));
  const v1 = view(s);
  assert.equal(v1.cmdTax, 2, 'próxima conjuração custa +2');
  apply(s, { t: 'move', uid: cmdUid, to: 'command' });
  apply(s, { t: 'castCommander' });
  assert.equal(s.players.p1.cmdCasts, 2);
  assert.equal(view(s).cmdTax, 4);
});

test('visão mascarada: sem ordem da biblioteca, com contagem e mana calculada', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: {} });
  apply(s, { t: 'mulligan', choice: 'keep' });
  const v = view(s, 'table');
  assert.equal(v.players.p1.zones.library, undefined, 'conteúdo da biblioteca nunca sai do servidor');
  assert.equal(typeof v.players.p1.zones.libraryCount, 'number');
  const json = JSON.stringify(v);
  assert.ok(!/"zones":\{"p1":\{"library":\[/.test(json));
  assert.ok(v.mana, 'mana disponível calculada');
  assert.equal(v.mana.G, 0, 'nenhum terreno no campo ainda');
});

test('suggestTap paga custo colorido virando terrenos certos', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: {} });
  apply(s, { t: 'mulligan', choice: 'keep' });
  const p = s.players.p1;
  const land1 = p.zones.hand[0], land2 = p.zones.hand[1];
  s.cards[land1].tpl = 'Forest';
  s.cards[land2].tpl = 'Mountain';
  apply(s, { t: 'move', uid: land1, to: 'battlefield' });
  apply(s, { t: 'move', uid: land2, to: 'battlefield' });
  s.cards[land1].sick = false;
  s.cards[land2].sick = false;
  let r = apply(s, { t: 'suggestTap', pips: { G: 1, R: 1 } });
  assert.ok(r.ok);
  assert.equal(s.cards[land1].tapped, true);
  assert.equal(s.cards[land2].tapped, true);
  assert.deepEqual(r.missing, {});
  apply(s, { t: 'untapAll' });
  r = apply(s, { t: 'suggestTap', pips: { U: 2 } });
  assert.deepEqual(r.missing, { U: 2 }, 'sem azul no campo');
  assert.equal(s.cards[land1].tapped, false, 'não virou nada de qualquer jeito');
});

test('suggestTap consome mana flutuante antes de virar terrenos', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: {} });
  apply(s, { t: 'mulligan', choice: 'keep' });
  apply(s, { t: 'floatingMana', color: 'R', delta: 2 });
  const land = s.players.p1.zones.hand[0];
  s.cards[land].tpl = 'Mountain';
  apply(s, { t: 'move', uid: land, to: 'battlefield' });
  const r = apply(s, { t: 'suggestTap', pips: { R: 2 } });
  assert.equal(s.floatingMana.R, 0);
  assert.equal(s.cards[land].tapped, false, 'flutuante cobriu tudo');
  assert.equal(r.tapped.length, 0);
});

test('dano de comandante 21 dá derrota, veneno 10 também', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: {} });
  apply(s, { t: 'mulligan', choice: 'keep' });
  apply(s, { t: 'oppAdd', name: 'Dummy' });
  for (let i = 0; i < 21; i++) apply(s, { t: 'oppCmdDamage', idx: 0, delta: 3 });
  assert.ok(s.flags.some((f) => f.type === 'cmdko'), '21+ de dano de comandante');
  for (let i = 0; i < 10; i++) apply(s, { t: 'poison', delta: 1 });
  assert.ok(s.flags.some((f) => f.type === 'loss'), '10 venenosos');
});

test('criação de token entra no campo com sickness', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: {} });
  apply(s, { t: 'mulligan', choice: 'keep' });
  apply(s, { t: 'createToken', name: 'Saproling', pow: 1, tou: 1, count: 2 });
  assert.equal(s.players.p1.zones.battlefield.length, 2);
  const uid = s.players.p1.zones.battlefield[0];
  assert.equal(s.cards[uid].sick, true);
  assert.equal(s.templates[s.cards[uid].tpl].token, true);
  apply(s, { t: 'counter', uid, name: '+1/+1', delta: 2 });
  assert.equal(s.cards[uid].counters['+1/+1'], 2);
  apply(s, { t: 'damage', uid, delta: 3 });
  assert.equal(s.cards[uid].damage, 3);
  apply(s, { t: 'clearDamage' });
  assert.equal(s.cards[uid].damage, 0);
});

test('ataque exige sem sickness e desvirado; marca atacante', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: {} });
  apply(s, { t: 'mulligan', choice: 'keep' });
  const uid = s.players.p1.zones.hand[3];
  apply(s, { t: 'move', uid, to: 'battlefield' });
  let r = apply(s, { t: 'attackToggle', uid });
  assert.equal(r.ok, false, 'sickness bloqueia');
  apply(s, { t: 'setSick', uid, value: false });
  r = apply(s, { t: 'attackToggle', uid });
  assert.ok(r.ok);
  assert.equal(s.cards[uid].attacking, true);
  assert.equal(s.cards[uid].tapped, true);
  apply(s, { t: 'attackToggle', uid });
  assert.equal(s.cards[uid].attacking, false);
});

test('ações bloqueadas durante o mulligan', () => {
  const s = createGame({ deck: fakeDeck(), basicCopies: {} });
  assert.equal(apply(s, { t: 'advancePhase' }).ok, false);
  assert.equal(apply(s, { t: 'draw' }).ok, false);
  assert.equal(apply(s, { t: 'move', uid: 'c10', to: 'battlefield' }).ok, false);
});

const PHASES = [
  'untap', 'upkeep', 'draw', 'main1',
  'combat-begin', 'combat-attackers', 'combat-blockers', 'combat-damage', 'combat-end',
  'main2', 'end', 'cleanup'
];

const PHASE_LABELS = {
  'untap': 'Untap', 'upkeep': 'Upkeep', 'draw': 'Draw', 'main1': 'Main 1',
  'combat-begin': 'Início Combate', 'combat-attackers': 'Atacantes',
  'combat-blockers': 'Bloqueadores', 'combat-damage': 'Dano', 'combat-end': 'Fim Combate',
  'main2': 'Main 2', 'end': 'Fim', 'cleanup': 'Cleanup'
};

const BASIC_FALLBACK = { Forest: 'G', Mountain: 'R', Island: 'U', Plains: 'W', Swamp: 'B', Wastes: 'C' };
const ALL_COLORS = ['W', 'U', 'B', 'R', 'G', 'C'];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createGame({ deck, basicCopies = {} }) {
  let seq = 0;
  const templates = {};
  const cards = {};
  const library = [];

  const slotCount = (tpl) => {
    let n = 1;
    if (tpl.typeClass === 'basic-land' && basicCopies[tpl.name]) n += basicCopies[tpl.name];
    return n;
  };

  for (const tpl of deck.cards) {
    templates[tpl.key] = { ...tpl };
    if (tpl.isCommander) continue;
    for (let i = 0; i < slotCount(tpl); i++) {
      const uid = 'c' + (++seq);
      cards[uid] = newCard(uid, tpl.key);
      library.push(uid);
    }
  }
  shuffle(library);

  let commanderUid = null;
  const cmdTpl = deck.commanderKey ? templates[deck.commanderKey] : null;
  if (cmdTpl) {
    commanderUid = 'c' + (++seq);
    cards[commanderUid] = newCard(commanderUid, cmdTpl.key);
  }

  const state = {
    stage: 'mulligan',
    deckId: deck.id,
    deckName: deck.name,
    turn: 1,
    phaseIdx: 0,
    activePlayer: 'p1',
    players: {
      p1: {
        id: 'p1', name: 'Você', life: 40, poison: 0,
        cmdCasts: 0, landPlayed: false,
        zones: {
          library, hand: [], battlefield: [], graveyard: [], exile: [],
          command: commanderUid ? [commanderUid] : [], stack: []
        }
      }
    },
    opponents: [],
    floatingMana: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    mulligan: { count: 0, phase: 'decide', bottomPicks: [] },
    templates,
    cards,
    flags: [],
    log: []
  };

  drawCards(state, 7);
  log(state, `Novo jogo — ${deck.name}. Comandante${cmdTpl ? ': ' + cmdTpl.name : ' não detectado'}.`,
    `Mão inicial de 7 cartas (mulligan 0).`);
  return state;
}

function newCard(uid, tplKey) {
  return {
    uid, tpl: tplKey, tapped: false, sick: false, attacking: false,
    damage: 0, counters: {}, faceDown: false, rotated: false,
    x: null, y: null, z: 0
  };
}

function log(state, ...msg) {
  state.log.push({ t: Date.now(), m: msg.join(' ') });
  if (state.log.length > 80) state.log.splice(0, state.log.length - 80);
}

function drawCards(state, n) {
  const p = state.players.p1;
  const drawn = [];
  for (let i = 0; i < n; i++) {
    if (!p.zones.library.length) break;
    const uid = p.zones.library.pop();
    p.zones.hand.push(uid);
    drawn.push(uid);
  }
  if (drawn.length < n) {
    state.flags.push({ type: 'deckout', msg: 'Biblioteca vazia — comprar com deck vazio seria derrota!' });
    log(state, `COMPRA FALHOU: biblioteca vazia (${drawn.length}/${n}).`);
  }
  return drawn;
}

function removeUid(arr, uid) {
  const i = arr.indexOf(uid);
  if (i >= 0) arr.splice(i, 1);
  return i >= 0;
}

function placeOnBattlefield(state, uid) {
  const card = state.cards[uid];
  if (typeof card.x === 'number' && typeof card.y === 'number') return;
  const n = state.players.p1.zones.battlefield.length;
  const col = n % 6;
  const row = Math.floor(n / 6);
  card.x = 210 + col * 150;
  card.y = 150 + row * 210;
}

function resetCardForZone(card, zone) {
  if (zone !== 'battlefield') {
    card.x = null; card.y = null; card.z = 0;
    card.tapped = false;
    card.attacking = false;
    card.damage = 0;
    card.counters = {};
    card.sick = false;
    card.faceDown = false;
  }
}

function templateOf(state, uid) {
  return state.templates[state.cards[uid].tpl];
}

function typeClassOf(state, uid) {
  const tpl = templateOf(state, uid);
  return tpl.typeClass;
}

function landDroppedThisTurn(state) {
  return state.players.p1.landPlayed;
}

function apply(state, action) {
  switch (action.t) {
    case 'mulligan': return doMulligan(state, action);
    case 'mulliganBottom': return doMulliganBottom(state, action);
    case 'draw': return doDraw(state);
    case 'advancePhase': return doAdvance(state);
    case 'setPhase': return doSetPhase(state, action.idx);
    case 'move': return doMove(state, action);
    case 'castCommander': return doCastCommander(state);
    case 'tapToggle': return doTap(state, action.uid);
    case 'rotate': return doRotate(state, action);
    case 'moveCard': return doMoveCard(state, action);
    case 'bringToFront': return doBringToFront(state, action);
    case 'untapAll': return doUntapAll(state);
    case 'attackToggle': return doAttackToggle(state, action.uid);
    case 'setSick': return doSetSick(state, action);
    case 'counter': return doCounter(state, action);
    case 'damage': return doDamage(state, action);
    case 'clearDamage': return doClearDamage(state, action.uid);
    case 'life': return doLife(state, action.delta);
    case 'setLife': return doSetLife(state, action.value);
    case 'poison': return doPoison(state, action.delta);
    case 'cmdCasts': return doCmdCasts(state, action.delta);
    case 'floatingMana': return doFloating(state, action);
    case 'floatingClear': return doFloatingClear(state);
    case 'suggestTap': return doSuggestTap(state, action);
    case 'shuffleLibrary': return doShuffleLibrary(state);
    case 'createToken': return doCreateToken(state, action);
    case 'oppAdd': return doOppAdd(state, action.name);
    case 'oppRemove': return doOppRemove(state, action.idx);
    case 'oppLife': return doOppLife(state, action);
    case 'oppCmdDamage': return doOppCmdDamage(state, action);
    default:
      return { ok: false, error: 'Ação desconhecida: ' + action.t };
  }
}

function requirePlay(state) {
  if (state.stage !== 'play') return { ok: false, error: 'Ainda estamos no mulligan' };
  return null;
}

function requireCard(state, uid) {
  if (!state.cards[uid]) return { ok: false, error: 'Carta inexistente: ' + uid };
  return null;
}

function doMulligan(state, choice) {
  if (state.stage !== 'mulligan') return { ok: false, error: 'Mulligan já encerrado' };
  const m = state.mulligan;
  const p = state.players.p1;
  if (choice.choice === 'keep') {
    if (m.count === 0) {
      state.stage = 'play';
      state.mulligan = null;
      log(state, 'Mão mantida sem mulligan. O jogo começa!');
      return { ok: true };
    }
    m.phase = 'bottom';
    return { ok: true, needBottom: m.count };
  }
  if (choice.choice === 'again') {
    if (m.phase !== 'decide') return { ok: false, error: 'Já escolhendo cartas do fundo' };
    for (const uid of p.zones.hand) state.cards[uid].tapped = false;
    p.zones.library.push(...p.zones.hand);
    p.zones.hand = [];
    shuffle(p.zones.library);
    drawCards(state, 7);
    m.count++;
    log(state, `Mulligan! Nova mão de 7 (mulligan ${m.count}). Ao manter, ${m.count} carta(s) vão para o fundo.`);
    return { ok: true };
  }
  return { ok: false, error: 'Escolha inválida' };
}

function doMulliganBottom(state, action) {
  if (state.stage !== 'mulligan') return { ok: false, error: 'Mulligan já encerrado' };
  const m = state.mulligan;
  const p = state.players.p1;
  if (m.phase !== 'bottom') return { ok: false, error: 'Não é hora de escolher o fundo' };
  const uids = action.uids || [];
  if (uids.length !== m.count) return { ok: false, error: `Escolha exatamente ${m.count} carta(s)` };
  if (!uids.every((u) => p.zones.hand.includes(u))) return { ok: false, error: 'Carta fora da mão' };
  for (const uid of uids) removeUid(p.zones.hand, uid);
  for (const uid of uids) p.zones.library.unshift(uid);
  state.stage = 'play';
  state.mulligan = null;
  log(state, `${uids.length} carta(s) para o fundo da biblioteca. Mão mantida — jogo iniciado!`);
  return { ok: true };
}

function doDraw(state) {
  const err = requirePlay(state);
  if (err) return err;
  const drawn = drawCards(state, 1);
  if (drawn.length) log(state, 'Comprou 1 carta.');
  return { ok: true };
}

function doAdvance(state) {
  return doSetPhase(state, (state.phaseIdx + 1) % PHASES.length, true);
}

function doSetPhase(state, idx, advance = false) {
  if (state.stage !== 'play') return { ok: false, error: 'Ainda estamos no mulligan' };
  if (typeof idx !== 'number' || idx < 0 || idx >= PHASES.length) return { ok: false, error: 'Fase inválida' };
  if (advance && idx <= state.phaseIdx) {
    state.turn++;
    idx = 0;
  }
  state.phaseIdx = idx;
  const phase = PHASES[idx];
  const p = state.players.p1;

  if (phase === 'untap') {
    for (const uid of p.zones.battlefield) {
      const c = state.cards[uid];
      c.tapped = false;
      c.attacking = false;
      c.sick = false;
    }
    p.landPlayed = false;
    for (const k of ALL_COLORS) state.floatingMana[k] = 0;
    log(state, `Turno ${state.turn} — Untap: desvirou tudo.`);
  }
  if (phase === 'draw') {
    if (state.turn === 1) {
      log(state, 'Turno 1: primeiro jogador não compra carta.');
    } else if (state.stage === 'play') {
      drawCards(state, 1);
      log(state, 'Compra automática do turno.');
    }
  }
  if (phase === 'cleanup') {
    for (const uid of p.zones.battlefield) state.cards[uid].damage = 0;
    for (const uid of p.zones.stack) resetCardForZone(state.cards[uid], 'stack');
    if (p.zones.hand.length > 7) {
      state.flags.push({ type: 'discard', msg: `Mão com ${p.zones.hand.length} cartas — descarte até 7.` });
      log(state, `Cleanup: mão com ${p.zones.hand.length} cartas, descarte até 7.`);
    } else {
      log(state, 'Cleanup: dano removido.');
    }
  }
  log(state, `Fase: ${PHASE_LABELS[PHASES[state.phaseIdx]]}.`);
  return { ok: true };
}

function findZoneOf(state, uid) {
  const p = state.players.p1;
  for (const [name, arr] of Object.entries(p.zones)) {
    if (arr.includes(uid)) return name;
  }
  return null;
}

function doMove(state, action) {
  if (state.stage !== 'play') return { ok: false, error: 'Ainda estamos no mulligan' };
  const err = requireCard(state, action.uid);
  if (err) return err;
  const from = findZoneOf(state, action.uid);
  if (!from) return { ok: false, error: 'Carta não está em nenhuma zona' };
  const to = action.to;
  const valid = ['hand', 'battlefield', 'graveyard', 'exile', 'command', 'stack', 'libraryTop', 'libraryBottom'];
  if (!valid.includes(to)) return { ok: false, error: 'Zona inválida: ' + to };
  if (to === 'command' && !templateOf(state, action.uid).isCommander) {
    return { ok: false, error: 'Só o comandante vai para a zona de comando' };
  }
  const p = state.players.p1;
  const card = state.cards[action.uid];
  if (from === 'battlefield' && to === 'battlefield') {
    removeUid(p.zones.battlefield, action.uid);
    const idx = typeof action.index === 'number' ? Math.max(0, Math.min(p.zones.battlefield.length, action.index)) : p.zones.battlefield.length;
    p.zones.battlefield.splice(idx, 0, action.uid);
    return { ok: true };
  }
  removeUid(p.zones[from], action.uid);

  if (to === 'libraryTop') {
    p.zones.library.push(action.uid);
    resetCardForZone(card, 'library');
    log(state, `${templateOf(state, action.uid).name} no topo da biblioteca.`);
    return { ok: true };
  }
  if (to === 'libraryBottom') {
    p.zones.library.unshift(action.uid);
    resetCardForZone(card, 'library');
    log(state, `${templateOf(state, action.uid).name} no fundo da biblioteca.`);
    return { ok: true };
  }

  const arr = p.zones[to];
  if (typeof action.index === 'number' && to === 'battlefield') {
    arr.splice(Math.max(0, Math.min(arr.length, action.index)), 0, action.uid);
  } else {
    arr.push(action.uid);
  }

  const tname = templateOf(state, action.uid).name;
  if (to === 'battlefield') {
    card.tapped = false;
    card.attacking = false;
    card.damage = 0;
    card.counters = {};
    card.sick = true;
    placeOnBattlefield(state, action.uid);
    const tc = templateOf(state, action.uid).typeClass;
    if (tc === 'land' || tc === 'basic-land') {
      if (p.landPlayed) {
        state.flags.push({ type: 'landdrop', msg: 'Atenção: você já jogou um terreno este turno.' });
        log(state, `AVISO: segundo terreno este turno (${tname}).`);
      }
      p.landPlayed = true;
    } else {
      log(state, `${tname} entrou no campo (com sickness).`);
    }
  } else {
    resetCardForZone(card, to);
    const zoneName = { hand: 'mão', graveyard: 'cemitério', exile: 'banido', command: 'zona de comando', stack: 'pilha' }[to];
    if (from === 'battlefield' || from === 'stack') log(state, `${tname} → ${zoneName}.`);
    else log(state, `${tname} → ${zoneName}.`);
  }
  return { ok: true };
}

function doCastCommander(state) {
  if (state.stage !== 'play') return { ok: false, error: 'Ainda estamos no mulligan' };
  const p = state.players.p1;
  const cmdUid = p.zones.command[0];
  if (!cmdUid) return { ok: false, error: 'Sem comandante na zona de comando' };
  const tax = p.cmdCasts * 2;
  const r = doMove(state, { uid: cmdUid, to: 'battlefield' });
  if (!r.ok) return r;
  p.cmdCasts++;
  log(state, `${templateOf(state, cmdUid).name} conjurado${tax ? ` (taxa +${tax} paga)` : ''}. Próxima taxa: +${p.cmdCasts * 2}.`);
  return { ok: true };
}

function doTap(state, uid) {
  const err = requireCard(state, uid);
  if (err) return err;
  const c = state.cards[uid];
  c.tapped = !c.tapped;
  if (c.tapped) c.attacking = false;
  return { ok: true };
}

function doRotate(state, action) {
  const err = requireCard(state, action.uid);
  if (err) return err;
  const c = state.cards[action.uid];
  c.rotated = typeof action.value === 'boolean' ? action.value : !c.rotated;
  return { ok: true };
}

function doMoveCard(state, action) {
  const err = requireCard(state, action.uid);
  if (err) return err;
  if (findZoneOf(state, action.uid) !== 'battlefield') return { ok: false, error: 'Carta não está no campo' };
  const c = state.cards[action.uid];
  if (typeof action.x === 'number') c.x = Math.round(Math.max(0, action.x));
  if (typeof action.y === 'number') c.y = Math.round(Math.max(0, action.y));
  if (typeof action.z === 'number') c.z = Math.round(action.z);
  return { ok: true };
}

function doBringToFront(state, action) {
  const err = requireCard(state, action.uid);
  if (err) return err;
  const p = state.players.p1;
  if (!p.zones.battlefield.includes(action.uid)) return { ok: false, error: 'Carta não está no campo' };
  const zs = p.zones.battlefield.map((u) => state.cards[u].z || 0);
  const max = zs.length ? Math.max(...zs) : 0;
  state.cards[action.uid].z = max + 1;
  return { ok: true };
}

function doUntapAll(state) {
  const p = state.players.p1;
  for (const uid of p.zones.battlefield) {
    state.cards[uid].tapped = false;
    state.cards[uid].attacking = false;
  }
  log(state, 'Desvirou tudo manualmente.');
  return { ok: true };
}

function doAttackToggle(state, uid) {
  const err = requireCard(state, uid);
  if (err) return err;
  const c = state.cards[uid];
  if (!c.attacking && c.tapped) return { ok: false, error: 'Carta virada não ataca' };
  if (c.attacking) {
    c.attacking = false;
  } else {
    if (c.sick) return { ok: false, error: 'Carta com sickness de invocação não ataca' };
    c.attacking = true;
    c.tapped = true;
    log(state, `${templateOf(state, uid).name} atacando.`);
  }
  return { ok: true };
}

function doSetSick(state, action) {
  const err = requireCard(state, action.uid);
  if (err) return err;
  state.cards[action.uid].sick = !!action.value;
  return { ok: true };
}

function doCounter(state, action) {
  const err = requireCard(state, action.uid);
  if (err) return err;
  const c = state.cards[action.uid];
  const name = action.name || '+1/+1';
  const delta = Number(action.delta) || 0;
  c.counters[name] = Math.max(0, (c.counters[name] || 0) + delta);
  if (c.counters[name] === 0) delete c.counters[name];
  return { ok: true };
}

function doDamage(state, action) {
  const err = requireCard(state, action.uid);
  if (err) return err;
  const c = state.cards[action.uid];
  c.damage = Math.max(0, c.damage + (Number(action.delta) || 0));
  return { ok: true };
}

function doClearDamage(state, uid) {
  if (uid) {
    const err = requireCard(state, uid);
    if (err) return err;
    state.cards[uid].damage = 0;
  } else {
    for (const c of Object.values(state.cards)) c.damage = 0;
  }
  return { ok: true };
}

function doLife(state, delta) {
  const p = state.players.p1;
  p.life += Number(delta) || 0;
  if (p.life <= 0) {
    state.flags.push({ type: 'loss', msg: 'Vida chegou a 0 — você perderia o jogo.' });
    log(state, `VIDA ZERO (${p.life}).`);
  }
  return { ok: true };
}

function doSetLife(state, value) {
  state.players.p1.life = Number(value) || 0;
  return { ok: true };
}

function doPoison(state, delta) {
  const p = state.players.p1;
  p.poison = Math.max(0, p.poison + (Number(delta) || 0));
  if (p.poison >= 10) {
    state.flags.push({ type: 'loss', msg: '10 marcadores de veneno — derrota!' });
  }
  return { ok: true };
}

function doCmdCasts(state, delta) {
  state.players.p1.cmdCasts = Math.max(0, state.players.p1.cmdCasts + (Number(delta) || 0));
  return { ok: true };
}

function doFloating(state, action) {
  const c = action.color;
  if (!ALL_COLORS.includes(c)) return { ok: false, error: 'Cor inválida' };
  state.floatingMana[c] = Math.max(0, state.floatingMana[c] + (Number(action.delta) || 0));
  return { ok: true };
}

function doFloatingClear(state) {
  for (const c of ALL_COLORS) state.floatingMana[c] = 0;
  return { ok: true };
}

function landProduces(state, uid) {
  const tpl = templateOf(state, uid);
  if (tpl.meta && tpl.meta.produces && tpl.meta.produces.length) return tpl.meta.produces;
  if (BASIC_FALLBACK[tpl.name]) return [BASIC_FALLBACK[tpl.name]];
  if (tpl.meta && tpl.meta.produces) return tpl.meta.produces;
  return [];
}

function availableMana(state) {
  const total = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  for (const c of ALL_COLORS) total[c] += state.floatingMana[c];
  const p = state.players.p1;
  for (const uid of p.zones.battlefield) {
    const tc = typeClassOf(state, uid);
    if (tc !== 'land' && tc !== 'basic-land') continue;
    for (const c of landProduces(state, uid)) total[c]++;
  }
  return total;
}

function doSuggestTap(state, action) {
  const err = requirePlay(state);
  if (err) return err;
  const p = state.players.p1;
  const pips = action.pips || {};
  const needed = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  for (const c of ALL_COLORS) needed[c] = Math.max(0, Number(pips[c]) || 0);

  const consumed = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  for (const c of ALL_COLORS) {
    const use = Math.min(needed[c], state.floatingMana[c]);
    consumed[c] = use;
    needed[c] -= use;
    state.floatingMana[c] -= use;
  }

  const lands = p.zones.battlefield.filter((uid) => {
    const tc = typeClassOf(state, uid);
    return (tc === 'land' || tc === 'basic-land') && !state.cards[uid].tapped;
  });
  const tapped = [];
  const take = (color) => {
    const idx = lands.findIndex((uid) => landProduces(state, uid).includes(color));
    if (idx < 0) return false;
    const [uid] = lands.splice(idx, 1);
    state.cards[uid].tapped = true;
    tapped.push(templateOf(state, uid).name);
    return true;
  };
  for (const c of ['W', 'U', 'B', 'R', 'G']) {
    while (needed[c] > 0) {
      if (!take(c)) break;
      needed[c]--;
    }
  }
  while (needed.C > 0) {
    const idx = lands.findIndex((uid) => landProduces(state, uid).length > 0);
    if (idx < 0) break;
    const [uid] = lands.splice(idx, 1);
    state.cards[uid].tapped = true;
    tapped.push(templateOf(state, uid).name);
    needed.C--;
  }
  const missing = {};
  for (const c of ALL_COLORS) if (needed[c] > 0) missing[c] = needed[c];
  if (tapped.length) log(state, `Pagando custo: virou ${tapped.join(', ')}.`);
  if (Object.keys(missing).length) {
    state.flags.push({ type: 'mana', msg: 'Mana insuficiente: falta ' + JSON.stringify(missing) });
  }
  return { ok: true, tapped, consumed, missing };
}

function doShuffleLibrary(state) {
  shuffle(state.players.p1.zones.library);
  log(state, `Biblioteca embaralhada (${state.players.p1.zones.library.length} cartas).`);
  return { ok: true };
}

function doCreateToken(state, action) {
  const err = requirePlay(state);
  if (err) return err;
  const name = (action.name || 'Token').slice(0, 40);
  const pow = String(action.pow ?? 1).slice(0, 3);
  const tou = String(action.tou ?? 1).slice(0, 3);
  const count = Math.max(1, Math.min(20, Number(action.count) || 1));
  const key = `token:${name}:${pow}/${tou}`;
  if (!state.templates[key]) {
    state.templates[key] = {
      key, name, file: null, category: 'Token', typeClass: 'token',
      scryName: null, meta: null, token: true, p: pow, t: tou
    };
  }
  const p = state.players.p1;
  let seq = 0;
  for (const uid of Object.keys(state.cards)) {
    const m = uid.match(/^t(\d+)$/);
    if (m) seq = Math.max(seq, Number(m[1]));
  }
  for (let i = 0; i < count; i++) {
    const uid = 't' + (++seq);
    state.cards[uid] = newCard(uid, key);
    state.cards[uid].sick = true;
    p.zones.battlefield.push(uid);
    placeOnBattlefield(state, uid);
  }
  log(state, `${count}x token ${name} ${pow}/${tou} criado(s).`);
  return { ok: true };
}

function doOppAdd(state, name) {
  if (state.opponents.length >= 5) return { ok: false, error: 'Máximo de 5 oponentes' };
  state.opponents.push({
    name: (name || 'Oponente ' + (state.opponents.length + 1)).slice(0, 24),
    life: 40, poison: 0, cmdDamage: {}
  });
  return { ok: true };
}

function doOppRemove(state, idx) {
  if (idx < 0 || idx >= state.opponents.length) return { ok: false, error: 'Oponente inválido' };
  state.opponents.splice(idx, 1);
  return { ok: true };
}

function doOppLife(state, action) {
  const opp = state.opponents[action.idx];
  if (!opp) return { ok: false, error: 'Oponente inválido' };
  opp.life += Number(action.delta) || 0;
  if (opp.life <= 0) {
    state.flags.push({ type: 'opploss', msg: `${opp.name} a 0 de vida — venceria o jogo.` });
  }
  return { ok: true };
}

function doOppCmdDamage(state, action) {
  const opp = state.opponents[action.idx];
  if (!opp) return { ok: false, error: 'Oponente inválido' };
  const p = state.players.p1;
  const cmdKey = p.zones.command[0] ? state.cards[p.zones.command[0]].tpl : 'commander';
  const prev = opp.cmdDamage[cmdKey] || 0;
  const next = Math.max(0, prev + (Number(action.delta) || 0));
  opp.cmdDamage[cmdKey] = next;
  if (prev < 21 && next >= 21) {
    state.flags.push({ type: 'cmdko', msg: `${opp.name} recebeu 21 de dano de comandante — perderia o jogo!` });
    log(state, `21 DE DANO DE COMANDANTE em ${opp.name}!`);
  }
  return { ok: true };
}

function view(state, role = 'table') {
  const s = JSON.parse(JSON.stringify(state));
  const p = s.players.p1;
  (p.zones.battlefield || []).forEach((uid, i) => {
    const c = s.cards[uid];
    if (!c) return;
    if (typeof c.x !== 'number' || typeof c.y !== 'number') {
      c.x = 210 + (i % 6) * 150;
      c.y = 150 + Math.floor(i / 6) * 210;
    }
    if (typeof c.z !== 'number') c.z = 0;
  });
  const libCount = p.zones.library.length;
  const libraryUids = p.zones.library.slice();
  delete p.zones.library;
  p.zones.libraryCount = libCount;
  p.zones.libraryUids = libraryUids;
  s.role = role;
  s.cmdTax = p.cmdCasts * 2;
  s.mana = availableMana(state);
  s.phaseLabel = PHASE_LABELS[PHASES[s.phaseIdx]];
  if (role === 'hand') {
    for (const other of Object.values(s.players)) {
      if (other.id !== 'p1') {
        other.zones.handCount = (other.zones.hand || []).length;
        delete other.zones.hand;
      }
    }
  }
  return s;
}

module.exports = {
  PHASES, PHASE_LABELS, ALL_COLORS,
  createGame, apply, view, shuffle, availableMana, landProduces
};

'use strict';

/* ---------- utils ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (tag, cls, html) => {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html != null) d.innerHTML = html;
  return d;
};
const cls = (...a) => a.filter(Boolean).join(' ');

const PHASES = ['untap', 'upkeep', 'draw', 'main1', 'combat-begin', 'combat-attackers', 'combat-blockers', 'combat-damage', 'combat-end', 'main2', 'end', 'cleanup'];
const PHASE_LABELS = {
  untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw', main1: 'Main 1',
  'combat-begin': 'In.Combat', 'combat-attackers': 'Ataque', 'combat-blockers': 'Bloqueio',
  'combat-damage': 'Dano', 'combat-end': 'FimComb', main2: 'Main 2', end: 'Fim', cleanup: 'Cleanup'
};
const COLORS = ['W', 'U', 'B', 'R', 'G', 'C'];
const COLOR_NAMES = { W: 'Branco', U: 'Azul', B: 'Preto', R: 'Vermelho', G: 'Verde', C: 'Incolor' };

const App = {
  info: null,
  net: null,
  role: null,
  ws: null,
  view: null,
  decks: [],
  screen: 'home',
  loading: null,
  drag: null,
  pendingRender: false,
  ui: {
    sheetUid: null, zoomUid: null, browserZone: null, menu: false,
    basics: null, token: false, picks: [], mulliganKey: '', loadMsg: null, confirmNew: false,
    netBusy: null, revealHand: false, netHelp: null, loadingDeck: false, panelHidden: false
  }
};

/* ---------- networking ---------- */
function toast(msg, type = '') {
  const t = el('div', 'toast ' + type, esc(msg));
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3400);
  setTimeout(() => t.remove(), 3800);
}

function connectWS(role) {
  if (App.ws) { try { App.ws.close(); } catch {} }
  App.role = role;
  localStorage.setItem('mesa.role', role);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?role=${role}`);
  App.ws = ws;
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMsg(msg);
  };
  ws.onclose = () => {
    if (App.ws !== ws) return;
    setTimeout(() => connectWS(App.role), 1500);
  };
}

function handleMsg(msg) {
  if (msg.t === 'hello') {
    App.info = msg.info;
    if (msg.flags && msg.flags.length) showFlags(msg.flags);
    if (msg.view) {
      App.view = msg.view;
      App.screen = 'game';
      App.ui.loadMsg = null;
      syncMulliganPicks();
    } else if (msg.load) {
      App.ui.loadMsg = { phase: msg.load.phase, done: msg.load.done, total: msg.load.total };
      App.screen = 'connect';
    } else if (App.screen !== 'home' && App.screen !== 'connect' && App.screen !== 'library') {
      App.screen = 'library';
      loadDecks();
    }
    render();
  } else if (msg.t === 'state') {
    App.view = msg.view;
    App.screen = 'game';
    App.ui.loadMsg = null;
    App.ui.loadingDeck = false;
    syncMulliganPicks();
    if (msg.flags && msg.flags.length) showFlags(msg.flags);
    render();
  } else if (msg.t === 'cleared') {
    App.view = null;
    App.screen = 'home';
    App.ui.loadMsg = null;
    App.ui.loadingDeck = false;
    App.ui.basics = null;
    loadInfo().then(render);
  } else if (msg.t === 'loadProgress') {
    if (msg.phase === 'done') {
      App.ui.loadingDeck = false;
      // mantém o overlay até a view do jogo chegar via 'state'
      return;
    }
    if (msg.phase === 'error') {
      App.ui.loadMsg = null;
      App.ui.loadingDeck = false;
      toast(msg.error || 'Falha ao carregar o deck', 'err');
      render();
      return;
    }
    App.ui.loadMsg = msg;
    render();
  }
}

function showFlags(flags) {
  for (const f of flags) {
    const type = f.type === 'loss' || f.type === 'deckout' || f.type === 'cmdko' || f.type === 'opploss' ? 'err' : 'warn';
    toast(f.msg, type);
  }
}

function syncMulliganPicks() {
  const v = App.view;
  const key = v && v.stage === 'mulligan' && v.mulligan ? `${v.mulligan.count}:${v.mulligan.phase}` : '';
  if (key !== App.ui.mulliganKey) {
    App.ui.mulliganKey = key;
    App.ui.picks = [];
  }
}

async function act(action, opts = {}) {
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action)
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) {
      if (!opts.silent) toast(j.error || 'Acao falhou', 'err');
      return j;
    }
    if (opts.closeSheet) App.ui.sheetUid = null;
    render();
    return j;
  } catch (e) {
    toast('Servidor offline? ' + e.message, 'err');
    return { ok: false };
  }
}

async function loadNetStatus() {
  try {
    const res = await fetch('/api/net/status');
    const j = await res.json();
    if (j.ok) { App.net = j; render(); }
  } catch {}
}

async function runNet(kind) {
  if (App.ui.netBusy && Date.now() - App.ui.netBusy < 120000) return;
  App.ui.netBusy = kind;
  render();
  toast('Confirme a autorização na janela do sistema…', 'warn');
  try {
    const res = await fetch('/api/net/' + kind, { method: 'POST' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) {
      toast(j.error || 'Falhou', 'err');
      if (j.needsAgent) {
        App.ui.netHelp = { title: kind === 'firewall' ? 'Liberar firewall' : 'Ligar Tailscale', text: j.error, command: j.command };
      }
    } else {
      toast(j.message || 'Feito');
      if (j.tailscale && j.tailscale.dnsName) App.forceTsUrl = true;
    }
  } catch (e) {
    toast('Falha: ' + e.message, 'err');
  }
  if (App.ui.netBusy) App.ui.netBusy = null;
  await loadNetStatus();
}

async function loadDecks() {
  try {
    const res = await fetch('/api/decks');
    const j = await res.json();
    if (j.ok) { App.decks = j.decks; render(); }
  } catch {}
}

/* ---------- rendering ---------- */
function render() {
  if (App.drag) { App.pendingRender = true; return; }
  const app = $('#app');
  if (!App.view && App.screen === 'game') App.screen = App.info && App.info.hasGame ? 'home' : 'connect';
  if (App.screen === 'home') app.innerHTML = viewHome();
  else if (App.screen === 'connect') app.innerHTML = viewConnect();
  else if (App.screen === 'library') app.innerHTML = viewLibrary();
  else app.innerHTML = viewGame();
  renderOverlays();
}

const LOGO_SVG = `<svg viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#151b20"/><rect x="140" y="86" width="232" height="324" rx="20" fill="#2a6d3a" stroke="#d9c06a" stroke-width="10"/><path d="M256 176l18 40 44 4-33 30 9 43-38-22-38 22 9-43-33-30 44-4z" fill="#d9c06a"/></svg>`;

function currentDeck() {
  return App.decks.find((x) => x.relPath === (App.info && App.info.lastDeck && App.info.lastDeck.relPath)) || null;
}

function tailscaleUrl() {
  const ts = App.net && App.net.tailscale;
  const port = (App.net && App.net.port) || (App.info && App.info.port) || 3000;
  if (ts && ts.state === 'Running' && (ts.dnsName || ts.ipv4)) {
    return `http://${ts.dnsName || ts.ipv4}:${port}/?role=hand`;
  }
  return '';
}

function lanUrl() {
  const info = App.info;
  const port = (App.net && App.net.port) || (info && info.port) || location.port || 3000;
  if (info && info.urls && info.urls.length) return `${info.urls[0]}/?role=hand`;
  return `${location.origin}/?role=hand`;
}

function viewQrBlock(url, { wifi = false } = {}) {
  if (!url) {
    const ts = (App.net && App.net.tailscale) || null;
    const msg = !ts ? 'Verificando…'
      : !ts.installed ? 'Tailscale não instalado.'
      : ts.state === 'Running' ? 'Tailscale ligado, mas sem endereço ainda.' : 'Ligue o Tailscale abaixo para liberar o QR do 4G.';
    return `<div class="qrbox"><div class="txt">${esc(msg)}</div></div>`;
  }
  return `<div class="qrbox">
    <img src="/api/qr?url=${encodeURIComponent(url)}" alt="QR ${wifi ? 'Wi-Fi' : '4G'}">
    <div class="txt">${wifi ? 'Wi-Fi (mesma rede)' : '4G/fora de casa (Tailscale)'} — abra a câmera e escaneie para entrar como <b>Mão</b>.<br>
    <code>${esc(url)}</code></div>
  </div>`;
}

function viewConnect() {
  return `<div class="screen">
    <div class="screen-head">
      <button data-act="backhome" class="ghost">‹ Início</button>
      <div class="spacer"></div>
      <button data-act="refreshdecks" class="ghost">↻</button>
    </div>
    <div class="center-wrap"><div class="panel">
      <div class="logo">${LOGO_SVG}
        <div><h1>Escolha o papel</h1><div class="muted small">Mesa no note · Mão no celular</div></div>
      </div>
      <div class="role-buttons">
        <button data-act="role" data-role="table"><span class="em">🖥️</span><span>Mesa</span><span class="muted small">interagir com as cartas</span></button>
        <button data-act="role" data-role="hand"><span class="em">📱</span><span>Mão</span><span class="muted small">ver e jogar suas cartas</span></button>
      </div>
      ${viewQrBlock(lanUrl(), { wifi: true })}
      ${viewQrBlock(tailscaleUrl())}
      ${viewNetOptions()}
    </div></div>
  </div>`;
}

function viewHome() {
  const info = App.info;
  const net = App.net;
  const deck = currentDeck();
  const lastDeck = info && info.lastDeck;
  const hasGame = !!(info && info.hasGame);
  const deckLine = deck
    ? `${deck.cardFiles} arquivos · ~${deck.cardFiles + sumCopies(deck.basicCopies || (deck.suggestion && deck.suggestion.copies) || {})} cartas com básicos`
    : (lastDeck ? esc(lastDeck.relPath) : 'Nenhum deck selecionado');
  const ts = (net && net.tailscale) || null;
  const tsOn = !!(ts && ts.state === 'Running');

  const contBtn = hasGame
    ? `<button class="primary big hbtn" data-act="continue">▶ Continuar partida — ${esc(info.gameName || '')}</button>`
    : '';

  return `<div class="screen home">
    <div class="screen-head">
      <div class="logo-mini">${LOGO_SVG}</div>
      <div><h1 style="font-size:1.15rem">Mesa Commander</h1>
      <div class="muted small">${esc(info ? info.vaultRoot : '')} · porta ${esc((net && net.port) || (info && info.port) || 3000)}</div></div>
      <div class="spacer"></div>
      <button class="ghost" data-act="changerole">${App.role === 'hand' ? '📱 Mão' : '🖥️ Mesa'}</button>
    </div>
    <div class="homebody">
      ${contBtn}
      <div class="card-panel">
        <div class="cp-head">
          <div><h2>Deck</h2><div class="name">${esc(deck ? deck.name : (lastDeck ? lastDeck.name : '—'))}</div>
          <div class="muted small">${deckLine}</div></div>
          <div class="cp-ico">🎴</div>
        </div>
        <div class="cp-actions">
          <button class="primary" data-act="opendeckpicker">Escolher deck</button>
          ${(deck || lastDeck) ? `<button class="danger" data-act="cleardeck">Limpar escolha</button>` : ''}
          ${hasGame ? `<button data-act="newgame">Reiniciar partida</button>` : ''}
          <button data-act="openmenu">☰ Menu</button>
        </div>
      </div>

      <div class="card-panel">
        <div class="cp-head"><div><h2>Celular (Mão)</h2><div class="muted small">${tsOn ? 'Wi-Fi e 4G disponíveis' : 'Wi-Fi agora; ligue o Tailscale para 4G'}</div></div><div class="cp-ico">📱</div></div>
        <div class="qrrow">
          <div>${viewQrBlock(lanUrl(), { wifi: true })}</div>
          <div>${viewQrBlock(tailscaleUrl())}</div>
        </div>
      </div>

      ${viewNetOptions()}
    </div>
  </div>`;
}

function viewNetOptions() {
  const net = App.net;
  const busy = App.ui.netBusy;
  const port = (net && net.port) || (App.info && App.info.port) || 3000;
  const expired = busy && Date.now() - busy > 120000;
  const iface = expired ? null : busy;
  let fwText = 'Verificando…';
  let fwBtn = '';
  if (net) {
    const fw = net.firewall || {};
    if (!fw.active) fwText = 'Firewall ufw desativado — acesso liberado.';
    else if (fw.allowed) fwText = `ufw ativo — porta ${port} liberada para ${(fw.allowed.cidrs || []).join(', ')}.`;
    else fwText = `ufw ativo — o celular pode não conseguir conectar.`;
    fwBtn = `<button data-act="netfirewall" ${iface ? 'disabled' : ''}>${iface === 'firewall' ? 'Aguardando…' : (fw.allowed ? 'Liberar novamente' : 'Liberar porta')}</button>`;
  }
  let ts = (net && net.tailscale) || null;
  let tsText = 'Verificando…';
  let tsBtn = '';
  let tsUrl = '';
  if (ts) {
    if (!ts.installed) tsText = 'Tailscale não instalado.';
    else if (ts.state === 'Running') {
      tsText = `Ligado${ts.dnsName ? ' — ' + ts.dnsName : ''}${ts.ipv4 ? ' · ' + ts.ipv4 : ''}`;
      const host = ts.dnsName || ts.ipv4;
      if (host) tsUrl = `http://${host}:${port}/?role=hand`;
    } else if (ts.state === 'Stopped') tsText = 'Desligado — ligue para usar fora de casa (4G).';
    else if (ts.state === 'NeedsLogin') tsText = 'Precisa de login no Tailscale.';
    else tsText = 'Estado: ' + ts.state + (ts.error ? ' — ' + ts.error : '');
    tsBtn = ts.installed && ts.state !== 'Running'
      ? `<button data-act="nettailscale" ${iface ? 'disabled' : ''}>${iface === 'tailscale' ? 'Aguardando…' : 'Ligar Tailscale'}</button>`
      : '';
  }
  return `<div class="netopts">
    <div class="netrow">
      <div><b>🛡 Firewall</b><div class="muted small">${esc(fwText)}</div></div>
      ${fwBtn}
    </div>
    <div class="netrow">
      <div><b>🌐 Tailscale (fora de casa)</b><div class="muted small">${esc(tsText)}</div></div>
      ${tsBtn}
    </div>
    ${tsUrl ? `<div class="neturl">No celular via 4G: <code>${esc(tsUrl)}</code></div>` : ''}
  </div>`;
}

function viewLibrary() {
  const items = App.decks.map((d, i) => {
    const total = (d.cardFiles || 0) + sumCopies(d.basicCopies || (d.suggestion && d.suggestion.copies) || {});
    return `<div class="deck-item" data-act="deckselect" data-i="${i}">
      <div class="icon">🎴</div>
      <div style="flex:1">
        <div class="name">${esc(d.name)}${d.lastLoadedAt ? '<span class="badge-recent">recente</span>' : ''}</div>
        <div class="sub">${esc(d.relPath)} · ${d.cardFiles} arquivos · ~${total} cartas com básicos</div>
      </div>
      <div>›</div>
    </div>`;
  }).join('') || '<div class="empty-hint">Nenhum deck encontrado no cofre.</div>';

  const cont = App.info && App.info.hasGame
    ? `<button class="primary big" style="margin:12px 16px 0" data-act="continue">▶ Continuar partida — ${esc(App.info.gameName || '')}</button>`
    : '';

  return `<div class="screen">
    <div class="screen-head">
      <button data-act="backhome" class="ghost">‹ Início</button>
      <div><h1 style="font-size:1.15rem">Escolher deck</h1>
      <div class="muted small">${esc(App.info ? App.info.vaultRoot : '')}</div></div>
      <div class="spacer"></div>
      <button data-act="changedevice" class="ghost" title="Trocar papel">${App.role === 'hand' ? '📱 Mão' : '🖥️ Mesa'}</button>
    </div>
    ${cont}
    <div class="screen-head" style="border-bottom:0;padding-bottom:0">
      <h2 style="font-size:.95rem">Biblioteca de decks</h2>
      <div class="spacer"></div>
      <button data-act="refreshdecks" class="ghost">↻ Atualizar</button>
    </div>
    <div class="deck-list">${items}</div>
  </div>`;
}

function sumCopies(copies) {
  return Object.values(copies || {}).reduce((a, b) => a + (Number(b) || 0), 0);
}

function tplOf(uid) {
  if (!App.view) return {};
  const c = App.view.cards[uid];
  return c ? App.view.templates[c.tpl] || {} : {};
}
function cardOf(uid) { return App.view.cards[uid]; }
function zoneOf(uid) {
  const z = App.view.players.p1.zones;
  for (const [name, arr] of Object.entries(z)) {
    if (Array.isArray(arr) && arr.includes(uid)) return name;
  }
  if (z.hand && Array.isArray(z.hand)) {}
  return null;
}

function cardEl(uid, { zone, draggable = false, cover = false, pos = false } = {}) {
  const c = cardOf(uid);
  if (!c) return '';
  const tpl = tplOf(uid);
  const classes = cls('card',
    c.tapped && 'tapped',
    c.sick && 'sick',
    c.attacking && 'attacking',
    tpl.isCommander && 'commander',
    tpl.token && 'token',
    (c.faceDown || cover) && 'facedown',
    cover && 'cover',
    pos && 'free');
  const counters = Object.entries(c.counters || {});
  const cntTxt = counters.map(([k, v]) => `${k}×${v}`).join(' ');
  let inner;
  if (tpl.token) {
    inner = `<div class="tokenface">
      <div class="tname">${esc(tpl.name)}</div>
      <div class="tpt">${esc(tpl.p)}/${esc(tpl.t)}</div>
      <div class="small muted">Token</div>
    </div>`;
  } else if (c.faceDown || cover) {
    inner = `<img class="cardback" src="/api/card-back" alt="verso" draggable="false">`;
  } else {
    const src = `/api/card-image?deck=${encodeURIComponent(App.view.deckId)}&file=${encodeURIComponent(tpl.file)}`;
    inner = `<img src="${src}" alt="${esc(tpl.name)}" draggable="false" loading="lazy">`;
  }
  const badges = cover ? '' : `<div class="badges">
    ${c.damage ? `<span class="b dmg">${c.damage}</span>` : ''}
    ${c.sick ? '<span class="b sick">💤</span>' : ''}
    ${c.attacking ? '<span class="b atk">⚔</span>' : ''}
    ${cntTxt ? `<span class="b cnt">${esc(cntTxt)}</span>` : ''}
  </div>`;
  let style = '';
  if (pos && typeof c.x === 'number' && typeof c.y === 'number') {
    style = ` style="left:${c.x}px;top:${c.y}px;z-index:${(c.z || 0) + 1}"`;
  } else if (pos) {
    style = ` style="z-index:${(c.z || 0) + 1}"`;
  }
  return `<div class="${classes}" data-uid="${uid}" data-zone="${zone || ''}" ${draggable ? 'data-draggable="1"' : ''}${style}>${inner}${badges}</div>`;
}

function viewGame() {
  const v = App.view;
  const table = App.role === 'table';
  const p = v.players.p1;
  const mulligan = v.stage === 'mulligan';
  const hand = p.zones.hand || [];
  const turnPill = `T${v.turn} · ${esc(PHASE_LABELS[PHASES[v.phaseIdx]] || v.phaseLabel)}`;

  const top = `<div class="gametop">
    <div class="deckname">${esc(v.deckName)}</div>
    <div class="turnpill">${turnPill}</div>
    <div class="tb-btns">
      ${table ? `<button data-act="togglepanel" title="${App.ui.panelHidden ? 'Mostrar painel' : 'Esconder painel'}">${App.ui.panelHidden ? '▸' : '◂'}</button>` : ''}
      <button data-act="undo" title="Desfazer">↶</button>
      <button data-act="switchrole" title="Trocar visão">${table ? '📱' : '🖥️'}</button>
      <button data-act="openmenu" title="Menu">☰</button>
    </div>
  </div>`;

  const phasebar = table ? `<div class="phasebar">
    ${PHASES.map((ph, i) => `<button class="phasechip ${i === v.phaseIdx ? 'active' : ''} ${ph.startsWith('combat') ? 'combat' : ''}" data-act="phase" data-idx="${i}">${PHASE_LABELS[ph]}</button>`).join('')}
    <div class="sep"></div>
    <button class="phasechip" data-act="advance" title="Avançar fase">▶ Avançar</button>
    <button class="phasechip" data-act="untapall" title="Desvirar tudo">↻ Desvirar</button>
  </div>` : '';

  if (!table) return `<div class="screen">${top}${viewHandBody()}</div>`;

  return `<div class="screen">${top}${phasebar}${viewTableBody()}${viewPiles()}${viewHandDock()}</div>`;
}

/* ---------- table ---------- */
function viewTableBody() {
  const v = App.view;
  const bf = v.players.p1.zones.battlefield || [];
  const opps = viewOpponents();
  const bfHtml = bf.length
    ? bf.map((uid) => cardEl(uid, { zone: 'battlefield', draggable: true, pos: true })).join('')
    : '';
  const emptyHint = bf.length ? '' : '<div class="empty-hint">Campo vazio — arraste cartas da mão ou toque numa pilha.</div>';
  const cmd = viewCommanderCorner();

  return `<div class="game-body${App.ui.panelHidden ? ' panel-hidden' : ''}">
    <aside class="sidepanel">
      ${viewLifeBlock()}
      ${viewManaBlock()}
      ${opps}
      ${viewLogBlock()}
    </aside>
    <button class="paneltoggle" data-act="togglepanel" title="${App.ui.panelHidden ? 'Mostrar painel' : 'Esconder painel'}">${App.ui.panelHidden ? '▸' : '◂'}</button>
    <div class="tablecenter">
      <div class="battlefield" id="battlefield" data-dropzone="battlefield">
        <div class="cmdcorner">${cmd}</div>
        <div class="freelayer">${bfHtml}</div>
        ${emptyHint}
      </div>
    </div>
  </div>`;
}

function viewCommanderCorner() {
  const v = App.view;
  const z = v.players.p1.zones;
  const cmdUid = (z.command || [])[0];
  const tpl = cmdUid ? tplOf(cmdUid) : Object.values(v.templates).find((t) => t.isCommander);
  if (!tpl) return '';
  if (cmdUid) {
    return `<div class="cmdcard">${cardEl(cmdUid, { zone: 'command' })}<div class="cmdlabel">Comandante</div><button class="cmdcast" data-act="castcommander">Conjurar${v.cmdTax ? ' +' + v.cmdTax : ''}</button></div>`;
  }
  const src = tpl.file ? `/api/card-image?deck=${encodeURIComponent(v.deckId)}&file=${encodeURIComponent(tpl.file)}` : '';
  return `<div class="cmdcard"><div class="card commander" data-uid="" data-zone="command">${src ? `<img src="${src}" alt="${esc(tpl.name)}" draggable="false">` : `<img class="cardback" src="/api/card-back" alt="verso" draggable="false">`}</div><div class="cmdlabel">${esc(tpl.name)} · no campo</div></div>`;
}

function viewOpponents() {
  const v = App.view;
  const cmdName = (() => {
    const t = Object.values(v.templates).find((x) => x.isCommander);
    return t ? t.name : 'Comandante';
  })();
  const list = v.opponents.map((o, i) => {
    const cmd = Object.values(o.cmdDamage || {}).reduce((a, b) => a + b, 0);
    return `<div class="opp-card">
      <div class="opp-head">
        <span class="opp-name">${esc(o.name)}</span>
        <span class="opp-life" style="color:${o.life <= 10 ? 'var(--red)' : 'var(--text)'}">${o.life}</span>
      </div>
      <div class="stepper" style="margin-top:4px">
        <button data-act="opplife" data-idx="${i}" data-delta="-5">-5</button>
        <button data-act="opplife" data-idx="${i}" data-delta="-1">-1</button>
        <button data-act="opplife" data-idx="${i}" data-delta="1">+1</button>
        <button data-act="opplife" data-idx="${i}" data-delta="5">+5</button>
        <button data-act="oppremove" data-idx="${i}" title="Remover" style="margin-left:auto">✕</button>
      </div>
      <div class="opp-cmd">⚔ ${esc(cmdName)}:
        <button data-act="oppcmd" data-idx="${i}" data-delta="-1">-</button>
        <b>${cmd}</b>/21
        <button data-act="oppcmd" data-idx="${i}" data-delta="1">+1</button>
        <button data-act="oppcmd" data-idx="${i}" data-delta="3">+3</button>
      </div>
    </div>`;
  }).join('');
  return `<div class="block"><h3>Oponentes <button data-act="oppadd" style="float:right;padding:1px 8px;font-size:.7rem">+ Add</button></h3>${list || '<div class="muted small">Nenhum. Adicione para trackear vida/dano de comandante.</div>'}</div>`;
}

function viewLifeBlock() {
  const p = App.view.players.p1;
  return `<div class="block">
    <h3>Você</h3>
    <div class="life-row">
      <button data-act="life" data-delta="-5">-5</button>
      <button data-act="life" data-delta="-1">-</button>
      <div class="life-num" style="color:${p.life <= 10 ? 'var(--red)' : 'var(--text)'}">${p.life}</div>
      <button data-act="life" data-delta="1">+</button>
      <button data-act="life" data-delta="5">+5</button>
    </div>
    <div class="row" style="margin-top:8px;font-size:.78rem">
      <span class="muted">Veneno</span>
      <div class="stepper">
        <button data-act="poison" data-delta="-1">-</button>
        <b>${p.poison}</b>
        <button data-act="poison" data-delta="1">+</button>
      </div>
      <span class="muted" style="margin-left:auto">Taxa cmd</span><b>+${App.view.cmdTax}</b>
    </div>
  </div>`;
}

function viewManaBlock() {
  const mana = App.view.mana || {};
  const fl = App.view.floatingMana || {};
  return `<div class="block">
    <h3>Mana disponível</h3>
    <div class="mana-chips">
      ${COLORS.map((c) => `<span class="mana-chip ${c} ${mana[c] ? '' : 'zero'}" title="${COLOR_NAMES[c]}">${c} ${mana[c] || 0}</span>`).join('')}
    </div>
    <h3 style="margin-top:10px">Flutuante</h3>
    <div class="float-row">
      ${COLORS.map((c) => `<span class="float-pill"><span class="mana-chip ${c}" style="padding:1px 5px">${c}</span>${fl[c] || 0}
        <button data-act="float" data-color="${c}" data-delta="-1">-</button>
        <button data-act="float" data-color="${c}" data-delta="1">+</button></span>`).join('')}
    </div>
    <button data-act="floatclear" style="margin-top:8px;width:100%;padding:5px;font-size:.72rem">Limpar flutuante</button>
  </div>`;
}

function viewLogBlock() {
  const log = (App.view.log || []).slice(-14).reverse();
  return `<div class="block"><h3>Log</h3><div class="log">${log.map((l) => `<div>${esc(l.m)}</div>`).join('') || '<div class="muted">—</div>'}</div></div>`;
}

function viewPiles() {
  const v = App.view;
  const z = v.players.p1.zones;
  const pile = (zone, label, count) => {
    const n = count || 0;
    return `<div class="pile${n ? ' has-cards' : ''}" data-dropzone="${zone}" data-act="browse" data-zone="${zone}" ${n ? '' : 'data-empty="1"'}>
      <div class="plabel">${label}</div><div class="pcount">${n}</div>
    </div>`;
  };
  return `<footer class="piles">
    <div class="pile libpile" data-dropzone="libraryTop" data-act="browse" data-zone="library">
      <div class="plabel">Biblioteca</div><div class="pcount">${z.libraryCount}</div>
      <div class="pactions">
        <button data-act="draw" title="Comprar 1">Comprar</button>
        <button data-act="shuffle" title="Embaralhar">↻</button>
      </div>
    </div>
    ${pile('graveyard', 'Cemitério', (z.graveyard || []).length)}
    ${pile('exile', 'Banido', (z.exile || []).length)}
    ${pile('stack', 'Pilha', (z.stack || []).length)}
    ${pile('command', 'Comando', (z.command || []).length)}
  </footer>`;
}

function viewHandDock() {
  const v = App.view;
  const hand = v.players.p1.zones.hand || [];
  if (!hand.length) return '';
  const open = App.ui.handOpen !== false;
  const m = v.stage === 'mulligan' ? (v.mulligan || { count: 0, phase: 'decide' }) : null;
  let mulliganBar = '';
  if (m) {
    if (m.phase === 'bottom') {
      const n = App.ui.picks.length;
      mulliganBar = `<div class="mulligan-note">Toque em <b>${m.count}</b> carta(s) na mão para colocar no fundo (${n}/${m.count})</div>
        <div class="handfoot"><button class="primary big" data-act="mulliganconfirm" ${n !== m.count ? 'disabled' : ''}>Confirmar fundo (${n}/${m.count})</button></div>`;
    } else {
      mulliganBar = `<div class="mulligan-note">Mão inicial${m.count ? ` — mulligan ${m.count}` : ''}. Manter ou embaralhar de volta?</div>
        <div class="handfoot">
          <button class="danger big" data-act="mulligan" data-choice="again">Mulligan</button>
          <button class="primary big" data-act="mulligan" data-choice="keep">Manter</button>
        </div>`;
    }
  }
  return `<div class="handdock" data-dropzone="hand">
    <div class="handdock-head">
      <button data-act="togglehand">${open ? '▾' : '▸'} Mão (${hand.length})</button>
      <button data-act="revealhand">${App.ui.revealHand ? '🙈 Ocultar' : '👁 Revelar'}</button>
      <span class="muted">toque para opções · arraste do campo para cá</span>
    </div>
    ${mulliganBar}
    ${open ? `<div class="handdock-cards">${hand.map((uid) => cardEl(uid, { zone: 'hand', draggable: true, cover: !App.ui.revealHand })).join('')}</div>` : ''}
  </div>`;
}

/* ---------- hand role ---------- */
function viewHandBody() {
  const v = App.view;
  const p = v.players.p1;
  const mulligan = v.stage === 'mulligan';
  const hand = p.zones.hand || [];
  const opps = v.opponents || [];

  const info = `<div class="handinfo">
    <div class="stepper"><button data-act="life" data-delta="-1">-</button><b>❤ ${p.life}</b><button data-act="life" data-delta="1">+</button></div>
    <span class="muted small">veneno ${p.poison}</span>
    ${opps.map((o, i) => `<div class="stepper"><span class="muted small">${esc(o.name)}</span><button data-act="opplife" data-idx="${i}" data-delta="-1">-</button><b>${o.life}</b><button data-act="opplife" data-idx="${i}" data-delta="1">+</button></div>`).join('')}
  </div>`;

  let foot;
  if (mulligan) {
    const m = v.mulligan || { count: 0, phase: 'decide' };
    if (m.phase === 'bottom') {
      const n = App.ui.picks.length;
      foot = `<div class="mulligan-note">Toque em <b>${m.count}</b> carta(s) para colocar no fundo (${n}/${m.count})</div>
        <div class="handfoot"><button class="primary big" data-act="mulliganconfirm" ${n !== m.count ? 'disabled' : ''}>Confirmar fundo (${n}/${m.count})</button></div>`;
    } else {
      foot = `<div class="handfoot">
        <button class="danger big" data-act="mulligan" data-choice="again">Mulligan</button>
        <button class="primary big" data-act="mulligan" data-choice="keep">Manter</button>
      </div>`;
    }
  } else {
    foot = `<div class="handfoot">
      <button class="primary big" data-act="draw">Comprar</button>
      <button data-act="advance">▶ ${esc(PHASE_LABELS[PHASES[v.phaseIdx]])}</button>
      <button data-act="undo" title="Desfazer">↶</button>
    </div>`;
  }

  const topNote = mulligan
    ? `<div class="mulligan-note">Mão inicial${(v.mulligan && v.mulligan.count) ? ` — mulligan ${v.mulligan.count}` : ''}. Manter ou embaralhar de volta?</div>`
    : '';

  return `<div class="handmain">
    ${info}
    ${topNote}
    <div class="handgrid ${mulligan ? 'mulligan' : ''}" data-dropzone="hand">
      ${hand.map((uid) => {
        const picked = mulligan && v.mulligan && v.mulligan.phase === 'bottom' && App.ui.picks.includes(uid);
        return cardEl(uid, { zone: 'hand' }).replace('class="card', 'class="card' + (picked ? ' pick' : ''));
      }).join('') || '<div class="empty-hint">Mão vazia.</div>'}
    </div>
    ${foot}
  </div>`;
}

/* ---------- overlays ---------- */
function renderOverlays() {
  const box = $('#overlays');
  const parts = [];
  const v = App.view;

  if (App.ui.loadMsg) {
    const m = App.ui.loadMsg;
    const pct = m.total ? Math.round((m.done / m.total) * 100) : 0;
    parts.push(`<div class="overlay center"><div class="sheet" style="max-width:420px">
      <div class="sheet-head"><h2>Carregando deck…</h2></div>
      <div class="sheet-body">
        <div class="muted small">${m.phase === 'scryfall' ? 'Buscando dados das cartas na Scryfall' : 'Lendo a pasta do cofre'}</div>
        <div class="progressbar"><div style="width:${m.phase === 'scryfall' ? pct : 15}%"></div></div>
        <div class="muted small">${m.name ? esc(m.name) : ''} ${m.total ? `(${m.done}/${m.total})` : ''}</div>
      </div></div></div>`);
  }

  if (App.ui.netHelp) {
    const h = App.ui.netHelp;
    parts.push(`<div class="overlay center"><div class="sheet">
      <div class="sheet-head"><h2>${esc(h.title)}</h2><div class="spacer"></div><button class="ghost" data-act="close">✕</button></div>
      <div class="sheet-body">
        <div class="muted small" style="margin-bottom:10px">${esc(h.text)}</div>
        <pre class="cmdbox">${esc(h.command || '')}</pre>
        <div class="muted small">Rode no terminal do note e toque em “Já fiz, verificar”.</div>
      </div>
      <div class="sheet-foot">
        <button data-act="close">Fechar</button>
        <button class="primary" data-act="netrecheck">Já fiz, verificar</button>
      </div></div></div>`);
  }

  if (App.ui.basics) {
    const b = App.ui.basics;
    const sum = sumCopies(b.inputs);
    const total = b.deck.cardFiles + sum;
    parts.push(`<div class="overlay center"><div class="sheet">
      <div class="sheet-head"><h2>${esc(b.deck.name)}</h2><div class="spacer"></div><button class="ghost" data-act="close">✕</button></div>
      <div class="sheet-body">
        <div class="muted small" style="margin-bottom:12px">Terrenos básicos no deck: escolha quantas cópias extras (básicos são isentos de singleton).</div>
        ${Object.keys(b.inputs).length ? Object.keys(b.inputs).map((name) => `<div class="formrow">
          <label>${esc(name)}</label>
          <button data-act="basicsstep" data-name="${esc(name)}" data-delta="-1">-</button>
          <input type="number" min="0" max="40" value="${b.inputs[name]}" data-basic="${esc(name)}">
          <button data-act="basicsstep" data-name="${esc(name)}" data-delta="1">+</button>
        </div>`).join('') : '<div class="muted small">Este deck não tem básicos detectados.</div>'}
        <div class="row" style="margin-top:10px">
          <span>Total do deck:</span><b>${total} cartas</b>
          <span class="muted small">(inclui comandante)</span>
          ${total === 100 ? '<span style="color:var(--green)">✓ 100</span>' : `<span class="muted small">(Commander pede 100)</span>`}
        </div>
      </div>
      <div class="sheet-foot">
        <button data-act="close">Cancelar</button>
        <button class="primary" data-act="basicsconfirm">Carregar e iniciar</button>
      </div></div></div>`);
  }

  if (App.ui.token) {
    const t = App.ui.token;
    parts.push(`<div class="overlay center"><div class="sheet" style="max-width:380px">
      <div class="sheet-head"><h2>Criar token</h2><div class="spacer"></div><button class="ghost" data-act="close">✕</button></div>
      <div class="sheet-body">
        <div class="formrow"><label>Nome</label><input id="tokenName" placeholder="Saproling" value="${esc(t.name || '')}"></div>
        <div class="formrow"><label>Poder/Resistência</label>
          <input id="tokenP" type="number" value="${t.pow || 1}" style="width:70px">
          <input id="tokenT" type="number" value="${t.tou || 1}" style="width:70px"></div>
        <div class="formrow"><label>Quantidade</label><input id="tokenN" type="number" min="1" max="20" value="${t.count || 1}" style="width:70px"></div>
        <div class="row" style="flex-wrap:wrap;gap:6px;margin-top:6px">
          ${[['Saproling', 1, 1], ['Tesouro', 0, 0], ['Comida', 0, 0], ['Soldado', 1, 1], ['Dragão', 5, 5], ['Cópia 2/2', 2, 2]].map((x) => `<button class="ghost" data-act="tokenpreset" data-name="${x[0]}" data-p="${x[1]}" data-t="${x[2]}" style="padding:4px 8px;font-size:.74rem">${x[0]} ${x[1]}/${x[2]}</button>`).join('')}
        </div>
      </div>
      <div class="sheet-foot"><button data-act="close">Cancelar</button><button class="primary" data-act="tokencreate">Criar</button></div>
    </div></div>`);
  }

  if (App.ui.zoomUid && v && v.cards[App.ui.zoomUid]) {
    const uid = App.ui.zoomUid;
    const tpl = tplOf(uid);
    const c = cardOf(uid);
    const img = tpl.file
      ? `<img class="zoomimg ${c.rotated ? 'rot180' : ''}" src="/api/card-image?deck=${encodeURIComponent(v.deckId)}&file=${encodeURIComponent(tpl.file)}">`
      : `<div class="zoomimg ${c.rotated ? 'rot180' : ''}" style="aspect-ratio:488/680;max-width:300px;margin:auto;background:linear-gradient(150deg,#4a3b1e,#241d10);border:2px solid #c7a94f;border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px"><b>${esc(tpl.name)}</b><span style="font-size:1.6rem">${esc(tpl.p)}/${esc(tpl.t)}</span></div>`;
    parts.push(`<div class="overlay center zoomoverlay" data-act="closezoom-bg">
      <div class="zoomwrap">
        <div class="zoomtop">
          <button class="ghost" data-act="closezoom">← Voltar</button>
          <div class="zoomtitle">${esc(tpl.name)}</div>
          <button class="ghost" data-act="closezoom">✕</button>
        </div>
        <div class="zoombody">${img}</div>
        <div class="zoomfoot">
          <button data-act="rotatetoggle" data-uid="${uid}" class="${v.role === 'table' ? 'primary' : ''}">${c.rotated ? '↺ Endireitar' : '↻ Girar p/ oponente'}</button>
          <button data-act="sheet" data-uid="${uid}" data-do="removetap">${App.ui.zoomBackSheet ? '← Ações' : 'Ações'}</button>
          <button data-act="tap" data-uid="${uid}">${c.tapped ? 'Desvirar' : 'Virar'}</button>
        </div>
      </div>
    </div>`);
  }

  if (App.ui.browserZone && v) {
    const zone = App.ui.browserZone;
    const zoneNames = { graveyard: 'Cemitério', exile: 'Banido', command: 'Zona de Comando', stack: 'Pilha', hand: 'Mão', library: 'Biblioteca (deck)' };
    const arr = zone === 'library' ? (v.players.p1.zones.libraryUids || []) : (v.players.p1.zones[zone] || []);
    parts.push(`<div class="overlay"><div class="sheet">
      <div class="sheet-head"><h2>${zoneNames[zone] || zone} (${arr.length})</h2><div class="spacer"></div><button class="ghost" data-act="close">✕</button></div>
      <div class="sheet-body" style="padding:0">
        <div class="zonegrid">${arr.map((uid) => cardEl(uid, { zone })).join('') || '<div class="empty-hint">Vazio.</div>'}</div>
      </div>
    </div></div>`);
  }

  if (App.ui.sheetUid && v && v.cards[App.ui.sheetUid]) {
    parts.push(cardSheet(v, App.ui.sheetUid));
  }

  if (App.ui.menu) {
    parts.push(menuSheet());
  }

  box.innerHTML = parts.join('');
}

function parseMana(mana) {
  const pips = {};
  let generic = 0;
  const matches = String(mana || '').match(/\{[^}]+\}/g) || [];
  for (const sym of matches) {
    const s = sym.slice(1, -1);
    if (/^[WUBRG]$/.test(s)) pips[s] = (pips[s] || 0) + 1;
    else if (/^\d+$/.test(s)) generic += Number(s);
    else if (s === 'X') continue;
    else {
      if (s.includes('/')) { const c = (s.match(/[WUBRG]/g) || ['C'])[0]; pips[c] = (pips[c] || 0) + 1; }
      else generic += 1;
    }
  }
  return { pips, generic };
}

function cardSheet(v, uid) {
  const c = cardOf(uid);
  const tpl = tplOf(uid);
  const zone = zoneOf(uid);
  const isCommander = !!tpl.isCommander;
  const inBf = zone === 'battlefield';
  const isCreature = tpl.typeClass === 'creature' || tpl.typeClass === 'token' || (tpl.meta && /Creature/.test(tpl.meta.type_line || ''));
  const isLand = tpl.typeClass === 'land' || tpl.typeClass === 'basic-land';
  const img = tpl.file
    ? `<img src="/api/card-image?deck=${encodeURIComponent(v.deckId)}&file=${encodeURIComponent(tpl.file)}">`
    : `<div style="width:128px;aspect-ratio:488/680;border-radius:8px;background:linear-gradient(150deg,#4a3b1e,#241d10);border:2px solid #c7a94f;display:flex;flex-direction:column;align-items:center;justify-content:center;flex:none;gap:4px"><b style="font-size:.72rem;text-align:center;padding:4px">${esc(tpl.name)}</b><b>${esc(tpl.p)}/${esc(tpl.t)}</b></div>`;

  const mana = tpl.meta ? tpl.meta.mana_cost : null;
  const parsed = mana ? parseMana(mana) : null;
  const canPay = parsed && (Object.keys(parsed.pips).length || parsed.generic);
  const inMulligan = v.stage === 'mulligan';

  const btns = [];
  if (inMulligan) {
    btns.push(`<button data-act="zoom" data-uid="${uid}">🔍 Zoom</button>`);
    return `<div class="overlay"><div class="sheet">
      <div class="sheet-head"><h2>${esc(tpl.name)}</h2><div class="spacer"></div><button class="ghost" data-act="close">✕</button></div>
      <div class="sheet-body"><div class="sheet-cardinfo">${img}<div class="meta">
        ${mana ? `<div class="manacost">${esc(mana)}</div>` : ''}
        <div class="muted">${esc(tpl.meta && tpl.meta.type_line ? tpl.meta.type_line : (tpl.category || ''))}</div>
        ${tpl.meta && tpl.meta.oracle_text ? `<div class="oracle">${esc(tpl.meta.oracle_text)}</div>` : ''}
      </div></div>
      <div class="actgrid">${btns.join('')}</div></div>
    </div></div>`;
  }
  btns.push(`<button data-act="zoom" data-uid="${uid}">🔍 Zoom</button>`);
  if (inBf) {
    btns.push(`<button data-act="tap" data-uid="${uid}">${c.tapped ? '⬆ Desvirar' : '↷ Virar'}</button>`);
    if (isCreature) btns.push(`<button data-act="attack" data-uid="${uid}">${c.attacking ? 'Sair do ataque' : '⚔ Atacar'}</button>`);
    btns.push(`<button data-act="sick" data-uid="${uid}" data-value="0">Sem sickness</button>`);
    btns.push(`<button data-act="sick" data-uid="${uid}" data-value="1">Com sickness</button>`);
  } else {
    btns.push(`<button data-act="move" data-uid="${uid}" data-to="battlefield">▶ Jogar no campo</button>`);
  }
  if (canPay) btns.push(`<button data-act="pay" data-uid="${uid}" class="primary">Pagar ${esc(mana)}</button>`);
  if (zone === 'hand') btns.push(`<button data-act="move" data-uid="${uid}" data-to="graveyard" class="danger">Descartar</button>`);
  if (isLand && zone === 'hand') btns.push(`<button data-act="move" data-uid="${uid}" data-to="battlefield" class="primary">Baixar terreno</button>`);
  if (isCommander && zone === 'command') btns.push(`<button data-act="castcommander" class="primary">Conjurar comandante${v.cmdTax ? ` (+${v.cmdTax})` : ''}</button>`);

  const counters = `<div class="actgroup-title">Marcadores</div><div class="actgrid">
    <button data-act="counter" data-uid="${uid}" data-name="+1/+1" data-delta="1">+1/+1</button>
    <button data-act="counter" data-uid="${uid}" data-name="+1/+1" data-delta="-1">−1/+1</button>
    <button data-act="counter" data-uid="${uid}" data-name="-1/-1" data-delta="1">−1/−1</button>
    <button data-act="countercustom" data-uid="${uid}">Outro…</button>
    <button data-act="damage" data-uid="${uid}" data-delta="1">Dano +1</button>
    <button data-act="damage" data-uid="${uid}" data-delta="-1">Dano −1</button>
    <button data-act="cleardamage" data-uid="${uid}">Limpar dano</button>
  </div>`;

  const moves = `<div class="actgroup-title">Mover para</div><div class="actgrid">
    <button data-act="move" data-uid="${uid}" data-to="hand">Mão</button>
    <button data-act="move" data-uid="${uid}" data-to="battlefield">Campo</button>
    <button data-act="move" data-uid="${uid}" data-to="graveyard">Cemitério</button>
    <button data-act="move" data-uid="${uid}" data-to="exile">Banido</button>
    <button data-act="move" data-uid="${uid}" data-to="stack">Pilha</button>
    <button data-act="move" data-uid="${uid}" data-to="libraryTop">Topo do deck</button>
    <button data-act="move" data-uid="${uid}" data-to="libraryBottom">Fundo do deck</button>
    ${isCommander ? `<button data-act="move" data-uid="${uid}" data-to="command">Zona de comando</button>` : ''}
  </div>`;

  return `<div class="overlay"><div class="sheet">
    <div class="sheet-head"><h2>${esc(tpl.name)}</h2><div class="spacer"></div><button class="ghost" data-act="close">✕</button></div>
    <div class="sheet-body">
      <div class="sheet-cardinfo">
        ${img}
        <div class="meta">
          ${mana ? `<div class="manacost">${esc(mana)}</div>` : ''}
          <div class="muted">${esc(tpl.meta && tpl.meta.type_line ? tpl.meta.type_line : (tpl.category || ''))}</div>
          ${zone ? `<div class="muted small" style="margin-top:6px">Zona: ${esc(zone)}</div>` : ''}
          ${c.damage ? `<div style="color:var(--red)">Dano marcado: ${c.damage}</div>` : ''}
          ${Object.keys(c.counters || {}).length ? `<div style="color:var(--green)">${Object.entries(c.counters).map(([k, x]) => `${esc(k)}×${x}`).join(' ')}</div>` : ''}
        </div>
      </div>
      <div class="actgrid">${btns.join('')}</div>
      ${counters}
      ${moves}
    </div>
  </div></div>`;
}

function menuSheet() {
  const v = App.view;
  const isHand = App.role === 'hand';
  return `<div class="overlay"><div class="sheet">
    <div class="sheet-head"><h2>Menu</h2><div class="spacer"></div><button class="ghost" data-act="close">✕</button></div>
    <div class="sheet-body">
      <div class="actgrid">
        <button data-act="advance">▶ Avançar fase</button>
        <button data-act="phase" data-idx="0">↻ Untap (desvirar)</button>
        <button data-act="draw">Comprar carta</button>
        <button data-act="shuffle">Embaralhar deck</button>
        <button data-act="tokenopen">Criar token</button>
        <button data-act="oppadd">+ Oponente</button>
        <button data-act="undo">↶ Desfazer</button>
        <button data-act="switchrole">${isHand ? '🖥️ Ver como mesa' : '📱 Ver como mão'}</button>
        <button data-act="newgame" class="danger">Novo jogo</button>
        <button data-act="changedeck" class="danger">Trocar deck</button>
      </div>
      <div class="actgroup-title">Cartas de exemplo</div>
      <div class="muted small">Arraste cartas no campo para reorganizar · toque para abrir ações.</div>
    </div>
  </div></div>`;
}

/* ---------- actions ---------- */
const handlers = {
  role: (d) => { App.role = d.role; App.ui.loadMsg = null; connectWS(d.role); render(); },
  backhome: () => { App.screen = 'home'; loadInfo().then(render); },
  changerole: () => { App.screen = 'connect'; render(); },
  opendeckpicker: () => { App.screen = 'library'; loadDecks(); render(); },
  cleardeck: async () => {
    if (!confirm('Limpar a escolha do deck? Isso também encerra a partida atual.')) return;
    try {
      const res = await fetch('/api/decks/clear', { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { toast(j.error || 'Falha ao limpar', 'err'); return; }
      App.view = null;
      App.screen = 'home';
      App.ui.basics = null;
      App.ui.loadMsg = null;
      await loadInfo();
      toast('Escolha do deck limpa', 'ok');
      render();
    } catch (e) { toast('Falha ao limpar: ' + e.message, 'err'); }
  },
  switchrole: () => { connectWS(App.role === 'table' ? 'hand' : 'table'); render(); },
  changedevice: () => { App.screen = 'connect'; render(); },
  continue: () => { App.ui.loadMsg = null; App.screen = 'game'; render(); },
  refreshdecks: () => loadDecks(),
  netfirewall: () => runNet('firewall'),
  nettailscale: () => runNet('tailscale'),
  revealhand: () => { App.ui.revealHand = !App.ui.revealHand; render(); },
  togglepanel: () => { App.ui.panelHidden = !App.ui.panelHidden; render(); },
  netrecheck: async () => { App.ui.netHelp = null; render(); await loadNetStatus(); },

  deckselect: (d) => {
    const deck = App.decks[Number(d.i)];
    if (!deck) return;
    const copies = { ...(deck.basicCopies || (deck.suggestion && deck.suggestion.copies) || {}) };
    if (!Object.keys(copies).length && deck.suggestion) Object.assign(copies, deck.suggestion.copies);
    App.ui.basics = { deck, inputs: copies };
    render();
  },
  basicsstep: (d) => {
    const b = App.ui.basics; if (!b) return;
    b.inputs[d.name] = Math.max(0, Math.min(40, (b.inputs[d.name] || 0) + Number(d.delta)));
    render();
  },
  basicsconfirm: async () => {
    const b = App.ui.basics; if (!b) return;
    document.querySelectorAll('[data-basic]').forEach((inp) => {
      b.inputs[inp.dataset.basic] = Math.max(0, Math.min(40, Number(inp.value) || 0));
    });
    App.ui.basics = null;
    App.ui.loadMsg = { phase: 'loading', done: 0, total: 0 };
    App.ui.loadingDeck = true;
    render();
    const safety = setTimeout(() => {
      if (!App.ui.loadingDeck) return;
      App.ui.loadMsg = null;
      App.ui.loadingDeck = false;
      toast('O carregamento demorou demais. Atualize se o deck não aparecer.', 'warn');
      render();
    }, 180000);
    try {
      const res = await fetch('/api/decks/load', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relPath: b.deck.relPath, basicCopies: b.inputs })
      });
      const j = await res.json().catch(() => ({}));
      App.ui.loadingDeck = false;
      clearTimeout(safety);
      if (!res.ok || !j.ok) {
        App.ui.loadMsg = null;
        toast(j.error || 'Falha ao carregar', 'err');
        render();
        return;
      }
      // sucesso: o broadcast 'state' já troca para a tela de jogo; garante limpeza
      App.ui.loadMsg = null;
      await loadInfo();
      App.screen = 'game';
      render();
    } catch (e) {
      App.ui.loadingDeck = false;
      clearTimeout(safety);
      App.ui.loadMsg = null;
      toast('Servidor offline', 'err');
      render();
    }
  },

  undo: () => act({ t: 'undo' }),
  advance: () => act({ t: 'advancePhase' }),
  phase: (d) => act({ t: 'setPhase', idx: Number(d.idx) }),
  untapall: () => act({ t: 'untapAll' }),
  draw: () => act({ t: 'draw' }),
  shuffle: () => act({ t: 'shuffleLibrary' }),

  life: (d) => act({ t: 'life', delta: Number(d.delta) }),
  poison: (d) => act({ t: 'poison', delta: Number(d.delta) }),
  float: (d) => act({ t: 'floatingMana', color: d.color, delta: Number(d.delta) }),
  floatclear: () => act({ t: 'floatingClear' }),

  oppadd: () => { act({ t: 'oppAdd' }, { silent: true }); App.ui.menu = false; render(); },
  oppremove: (d) => act({ t: 'oppRemove', idx: Number(d.idx) }),
  opplife: (d) => act({ t: 'oppLife', idx: Number(d.idx), delta: Number(d.delta) }),
  oppcmd: (d) => act({ t: 'oppCmdDamage', idx: Number(d.idx), delta: Number(d.delta) }),

  openmenu: () => { App.ui.menu = true; render(); },
  close: () => { App.ui.menu = false; App.ui.token = false; App.ui.basics = null; App.ui.browserZone = null; App.ui.sheetUid = null; App.ui.zoomUid = null; App.ui.zoomBackSheet = false; render(); },
  closezoom: () => { App.ui.zoomUid = null; App.ui.zoomBackSheet = false; render(); },
  'closezoom-bg': () => { App.ui.zoomUid = null; App.ui.zoomBackSheet = false; render(); },
  rotatetoggle: (d) => { act({ t: 'rotate', uid: d.uid }, { silent: true }); },
  togglehand: () => { App.ui.handOpen = App.ui.handOpen === false; render(); },

  sheet: (d) => { App.ui.sheetUid = d.uid; App.ui.zoomUid = null; render(); },
  zoom: (d) => { App.ui.zoomUid = d.uid; App.ui.zoomBackSheet = true; App.ui.sheetUid = null; render(); },
  tap: (d) => act({ t: 'tapToggle', uid: d.uid }, { closeSheet: false }),
  attack: (d) => act({ t: 'attackToggle', uid: d.uid }),
  sick: (d) => act({ t: 'setSick', uid: d.uid, value: d.value === '1' }),
  counter: (d) => act({ t: 'counter', uid: d.uid, name: d.name, delta: Number(d.delta) }),
  damage: (d) => act({ t: 'damage', uid: d.uid, delta: Number(d.delta) }),
  cleardamage: (d) => act({ t: 'clearDamage', uid: d.uid }),
  countercustom: (d) => {
    const name = prompt('Nome do marcador (ex: carga, lealdade):');
    if (!name) return;
    act({ t: 'counter', uid: d.uid, name, delta: 1 });
  },
  move: async (d) => {
    const r = await act({ t: 'move', uid: d.uid, to: d.to });
    if (r.ok) { App.ui.sheetUid = null; render(); }
  },
  moveCard: (d) => act({ t: 'moveCard', uid: d.uid, x: Number(d.x), y: Number(d.y) }, { silent: true }),
  bringToFront: (d) => act({ t: 'bringToFront', uid: d.uid }, { silent: true }),
  castcommander: async () => {
    const r = await act({ t: 'castCommander' });
    if (r.ok) { App.ui.sheetUid = null; App.ui.menu = false; render(); }
  },
  pay: (d) => {
    const tpl = tplOf(d.uid);
    const parsed = parseMana(tpl.meta ? tpl.meta.mana_cost : '');
    const pips = { ...parsed.pips };
    if (parsed.generic) pips.C = parsed.generic;
    act({ t: 'suggestTap', pips });
  },
  browse: (d) => { App.ui.browserZone = d.zone; App.ui.menu = false; render(); },

  tokenopen: () => { App.ui.token = { name: 'Saproling', pow: 1, tou: 1, count: 1 }; App.ui.menu = false; render(); },
  tokenpreset: (d) => { App.ui.token = { ...App.ui.token, name: d.name, pow: Number(d.p), tou: Number(d.t) }; render(); },
  tokencreate: async () => {
    const name = $('#tokenName') ? $('#tokenName').value : 'Token';
    const pow = Number($('#tokenP') && $('#tokenP').value) || 0;
    const tou = Number($('#tokenT') && $('#tokenT').value) || 0;
    const count = Math.max(1, Math.min(20, Number($('#tokenN') && $('#tokenN').value) || 1));
    const r = await act({ t: 'createToken', name, pow, tou, count });
    if (r.ok) { App.ui.token = false; render(); }
  },

  mulligan: (d) => act({ t: 'mulligan', choice: d.choice }),
  mulliganconfirm: () => act({ t: 'mulliganBottom', uids: App.ui.picks.slice() }),

  newgame: async () => {
    App.ui.menu = false;
    if (App.screen !== 'game' && !confirm('Começar um novo jogo com o mesmo deck?')) return;
    const res = await fetch('/api/game/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await res.json();
    if (!j.ok) toast(j.error || 'Falha', 'err');
    render();
  },
  changedeck: () => { App.ui.menu = false; App.screen = 'library'; loadDecks(); render(); }
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  if (btn.dataset.empty === '1' && !e.target.closest('button')) return;
  const actName = btn.dataset.act;
  if (actName === 'close') { App.ui.netHelp = null; }
  const fn = handlers[actName];
  if (!fn) return;
  e.preventDefault();
  e.stopPropagation();
  fn(btn.dataset, e);
});

document.addEventListener('change', (e) => {
  const inp = e.target.closest('[data-basic]');
  if (inp && App.ui.basics) {
    App.ui.basics.inputs[inp.dataset.basic] = Math.max(0, Math.min(40, Number(inp.value) || 0));
    render();
  }
});

/* ---------- tap & drag ---------- */
let pdown = null;

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  const interactive = e.target.closest('[data-act], button, input, select, textarea, a');
  const card = e.target.closest('.card');
  if (!card || !card.dataset.uid || interactive) return;
  if (App.ui.sheetUid || App.ui.zoomUid || App.ui.basics || App.ui.menu || App.ui.browserZone) return;
  pdown = {
    uid: card.dataset.uid,
    zone: card.dataset.zone,
    x: e.clientX, y: e.clientY,
    moved: false, ghost: null, dropEl: null,
    draggable: card.dataset.draggable === '1'
  };
});

window.addEventListener('pointermove', (e) => {
  if (!pdown) return;
  const dx = e.clientX - pdown.x;
  const dy = e.clientY - pdown.y;
  if (!pdown.moved && !pdown.draggable && Math.hypot(dx, dy) > 10) pdown.scrolled = true;
  if (!pdown.moved && pdown.draggable && Math.hypot(dx, dy) > 14) {
    pdown.moved = true;
    App.drag = pdown;
    const ghost = $('#dragghost');
    const card = document.querySelector(`.card[data-uid="${pdown.uid}"]`);
    ghost.innerHTML = card ? card.innerHTML : '';
    ghost.hidden = false;
  }
  if (pdown.moved) {
    e.preventDefault();
    const ghost = $('#dragghost');
    ghost.style.left = e.clientX + 'px';
    ghost.style.top = e.clientY + 'px';
    $$('.drop-hot').forEach((x) => x.classList.remove('drop-hot'));
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const dz = under && under.closest('[data-dropzone]');
    pdown.dropEl = dz;
    if (dz) dz.classList.add('drop-hot');
  }
}, { passive: false });

window.addEventListener('pointerup', (e) => {
  if (!pdown) return;
  const p = pdown;
  pdown = null;
  if (p.moved) {
    finishDrag(p, e);
  } else if (!p.scrolled) {
    handleTap(p.uid);
  }
});

window.addEventListener('pointercancel', () => {
  if (pdown) { pdown = null; cleanupDrag(); }
});

function cleanupDrag() {
  App.drag = null;
  const ghost = $('#dragghost');
  if (ghost) ghost.hidden = true;
  $$('.drop-hot').forEach((x) => x.classList.remove('drop-hot'));
  if (App.pendingRender) { App.pendingRender = false; render(); }
}

function finishDrag(p, e) {
  const dz = p.dropEl;
  cleanupDrag();
  if (!dz) return;
  const to = dz.dataset.dropzone;
  if (!to) return;

  if (to === 'battlefield') {
    const bf = document.querySelector('#battlefield');
    const r = bf.getBoundingClientRect();
    const cardElNow = document.querySelector(`.card[data-uid="${p.uid}"]`);
    const cw = cardElNow ? cardElNow.getBoundingClientRect().width : 150;
    const ch = cardElNow ? cardElNow.getBoundingClientRect().height : 209;
    const x = Math.max(0, Math.round(e.clientX - r.left - cw / 2 + bf.scrollLeft));
    const y = Math.max(0, Math.round(e.clientY - r.top - ch / 2 + bf.scrollTop));
    if (p.zone === 'battlefield') {
      act({ t: 'moveCard', uid: p.uid, x, y }, { silent: true });
    } else {
      act({ t: 'move', uid: p.uid, to: 'battlefield' }, { silent: true }).then(() => {
        act({ t: 'moveCard', uid: p.uid, x, y }, { silent: true });
      });
    }
    return;
  }

  if (p.zone === 'battlefield') {
    // reposicionar o campo para outras zonas: empurra a posição para o topo (mantém x/y fora do campo)
    act({ t: 'move', uid: p.uid, to });
  } else {
    act({ t: 'move', uid: p.uid, to });
  }
}

function handleTap(uid) {
  const v = App.view;
  if (!v) return;
  if (v.stage === 'mulligan' && v.mulligan && v.mulligan.phase === 'bottom') {
    const i = App.ui.picks.indexOf(uid);
    if (i >= 0) App.ui.picks.splice(i, 1);
    else if (App.ui.picks.length < v.mulligan.count) App.ui.picks.push(uid);
    render();
    return;
  }
  if (v.stage === 'mulligan' && v.mulligan && v.mulligan.phase === 'decide') {
    App.ui.sheetUid = uid;
    render();
    return;
  }
  if (zoneOf(uid) === 'battlefield') act({ t: 'bringToFront', uid }, { silent: true });
  App.ui.sheetUid = uid;
  App.ui.zoomUid = null;
  render();
}

/* ---------- boot ---------- */
(function boot() {
  const params = new URLSearchParams(location.search);
  const qrole = params.get('role');
  const role = qrole === 'hand' || qrole === 'table' ? qrole : null;
  App.screen = 'home';
  render();
  const refresh = () => Promise.all([loadInfo(), loadDecks(), loadNetStatus()]).then(() => render());
  refresh().then(() => {
    if (role) connectWS(role);
  });
  setInterval(() => { if (App.screen === 'home') refresh(); }, 15000);
})();

async function loadInfo() {
  try {
    const res = await fetch('/api/info');
    App.info = await res.json();
  } catch {}
}

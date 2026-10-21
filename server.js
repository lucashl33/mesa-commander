const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const { WebSocketServer } = require('ws');
const execFileP = promisify(execFile);
const QRCode = require('qrcode');
const { scanDecks, loadDeck, readRegistry, upsertRegistry, suggestBasicCopies } = require('./lib/deck');
const { fetchMissing, readDb } = require('./lib/scryfall');
const game = require('./lib/game');

const ROOT = __dirname;
const DATA_DIR = process.env.MTG_DATA_DIR ? path.resolve(process.env.MTG_DATA_DIR) : path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : null;
};

function readConfig() {
  const cfgPath = path.join(ROOT, 'config.json');
  const examplePath = path.join(ROOT, 'config.example.json');
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error('\n  Arquivo config.json não encontrado.');
      console.error(`  Copie o exemplo e ajuste o caminho do cofre:`);
      console.error(`      cp config.example.json config.json`);
      console.error(`  Depois edite "vaultRoot" com a pasta onde estão seus decks.\n`);
    } else {
      console.error('\n  Erro ao ler config.json:', e.message, '\n');
    }
    process.exit(1);
  }
}

const config = readConfig();
const PORT = Number(process.env.PORT || arg('port') || config.port || 3000);
const VAULT = path.resolve(process.env.VAULT_ROOT || arg('vault') || config.vaultRoot || '');

if (!VAULT || !fs.existsSync(VAULT)) {
  console.error(`\n  Pasta do cofre não encontrada: ${VAULT || '(vazio)'}`);
  console.error(`  Ajuste "vaultRoot" no config.json (ou defina a variável VAULT_ROOT).\n`);
  process.exit(1);
}

let state = null;
let lastDeck = null;
let past = [];
let loadInProgress = null;
let saveTimer = null;

function loadPersistedGame() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'last-game.json'), 'utf8'));
    if (raw && raw.state) {
      state = raw.state;
      lastDeck = raw.lastDeck || null;
      console.log(`Partida restaurada: ${state.deckName} (turno ${state.turn}, ${state.stage})`);
    }
  } catch {}
}

function persistSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'last-game.json'), JSON.stringify({ savedAt: Date.now(), lastDeck, state }));
    } catch (e) {
      console.error('Falha ao salvar partida:', e.message);
    }
  }, 300);
}

function snapshot() {
  past.push(JSON.parse(JSON.stringify(state)));
  if (past.length > 80) past.shift();
}

function undo() {
  if (!past.length) return { ok: false, error: 'Nada para desfazer' };
  state = past.pop();
  return { ok: true };
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

const NET_FILE = path.join(DATA_DIR, 'net.json');
function readNetState() {
  try { return JSON.parse(fs.readFileSync(NET_FILE, 'utf8')); } catch { return {}; }
}
function writeNetState(obj) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(NET_FILE, JSON.stringify(obj, null, 2)); } catch {}
}

function lanNets() {
  const out = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const ip = info.address.split('.').map(Number);
      const mask = (info.netmask || '255.255.255.0').split('.').map(Number);
      const net = ip.map((o, i) => o & mask[i]);
      const bits = mask.reduce((a, o) => a + ((o >>> 0).toString(2).match(/1/g) || []).length, 0);
      out.push({ iface: name, address: info.address, netmask: info.netmask, cidr: `${net.join('.')}/${bits}` });
    }
  }
  return out;
}

async function ufwActive() {
  try {
    const { stdout } = await execFileP('systemctl', ['is-active', 'ufw'], { timeout: 4000 });
    return stdout.trim() === 'active';
  } catch (e) {
    return (e.stdout || '').trim() === 'active';
  }
}

async function tailscaleStatus() {
  try {
    const { stdout } = await execFileP('tailscale', ['status', '--json'], { timeout: 5000 });
    const d = JSON.parse(stdout);
    const self = d.Self || {};
    return {
      installed: true,
      state: d.BackendState || 'Unknown',
      ipv4: (self.TailscaleIPs || []).find((x) => x.includes('.')) || null,
      dnsName: self.DNSName ? self.DNSName.replace(/\.$/, '') : null,
      hostname: self.HostName || os.hostname()
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { installed: false, state: 'Missing' };
    return { installed: true, state: 'Unknown', error: (e.stderr || e.message || '').toString().trim() };
  }
}

function networkAddresses() {
  const out = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal) out.push({ iface: name, address: info.address });
    }
  }
  return out;
}

function infoPayload() {
  const addrs = networkAddresses();
  const host = os.hostname();
  return {
    port: PORT,
    hostname: host,
    vaultRoot: VAULT,
    addresses: addrs,
    urls: addrs.map((a) => `http://${a.address}:${PORT}`),
    lastDeck,
    hasGame: !!state,
    gameName: state ? state.deckName : null,
    loadInProgress: loadInProgress ? { phase: loadInProgress.phase, done: loadInProgress.done, total: loadInProgress.total, relPath: loadInProgress.relPath } : null
  };
}

function broadcast(type, extra = {}) {
  const flags = state ? state.flags : [];
  if (state) state.flags = [];
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    const payload = { t: type, ...extra };
    if (state) payload.view = game.view(state, ws.role || 'table');
    if (type === 'state') payload.flags = flags;
    try { ws.send(JSON.stringify(payload)); } catch {}
  }
}

function pushState() {
  if (state) persistSoon();
  broadcast('state');
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  ws.role = url.searchParams.get('role') === 'hand' ? 'hand' : 'table';
  clients.add(ws);
  const hello = { t: 'hello', role: ws.role, info: infoPayload(), hasGame: !!state };
  if (state) hello.view = game.view(state, ws.role);
  if (state) hello.flags = state.flags;
  if (state) state.flags = [];
  if (loadInProgress) hello.load = { phase: loadInProgress.phase, done: loadInProgress.done, total: loadInProgress.total };
  try { ws.send(JSON.stringify(hello)); } catch {}
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

app.get('/api/info', (req, res) => res.json(infoPayload()));

app.get('/api/net/status', async (req, res) => {
  try {
    const [active, tail] = await Promise.all([ufwActive(), tailscaleStatus()]);
    const ns = readNetState();
    res.json({
      ok: true,
      port: PORT,
      hostname: os.hostname(),
      lan: lanNets(),
      firewall: { active, allowed: ns.firewall || null },
      tailscale: tail
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function polkitAgent() {
  const candidates = [
    '/usr/lib/hyprpolkitagent/hyprpolkitagent',
    '/usr/bin/lxpolkit',
    '/usr/lib/polkit-gnome/polkit-gnome-authentication-agent-1',
    '/usr/bin/lxqt-policykit-agent',
    '/usr/bin/xfce-polkit',
    '/usr/bin/mate-polkit'
  ];
  for (const c of candidates) {
    try { if ((await fs.promises.stat(c)).isFile()) return c; } catch {}
  }
  return null;
}

async function pkexec(args) {
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0', WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-1' };
  const agent = await polkitAgent();
  let child;
  if (agent) {
    try {
      child = execFile(agent, [], { env, detached: true, stdio: 'ignore' });
      child.unref();
      await new Promise((r) => setTimeout(r, 600));
    } catch {}
  }
  try {
    return await execFileP('pkexec', args, { timeout: 180000, env });
  } finally {
    if (child && child.pid) { try { process.kill(child.pid); } catch {} }
  }
}

app.post('/api/net/firewall', async (req, res) => {
  try {
    const nets = lanNets();
    if (!nets.length) return res.status(400).json({ ok: false, error: 'Nenhuma rede local IPv4 detectada' });
    if (!(await polkitAgent())) {
      const cmds = nets.map((n) => `sudo ufw allow from ${n.cidr} to any port ${PORT} proto tcp`).join('\n');
      return res.status(503).json({
        ok: false, needsAgent: true,
        error: 'Falta um agente de autenticação gráfico (polkit). Instale com: sudo pacman -S hyprpolkitagent',
        command: cmds
      });
    }
    const cidrs = [];
    for (const n of nets) {
      await pkexec(['ufw', 'allow', 'from', n.cidr, 'to', 'any', 'port', String(PORT), 'proto', 'tcp']);
      cidrs.push(n.cidr);
    }
    const ns = readNetState();
    ns.firewall = { allowedAt: new Date().toISOString(), cidrs };
    writeNetState(ns);
    res.json({ ok: true, cidrs, message: 'Porta ' + PORT + ' liberada no firewall' });
  } catch (e) {
    const err = (e.stderr || e.message || '').toString().trim();
    res.status(500).json({ ok: false, error: e.killed ? 'Autorização expirou' : (err || 'Falha ao alterar o firewall') });
  }
});

app.post('/api/net/tailscale', async (req, res) => {
  try {
    const before = await tailscaleStatus();
    if (!before.installed) return res.status(400).json({ ok: false, error: 'Tailscale não está instalado' });
    if (before.state === 'Running') return res.json({ ok: true, already: true, message: 'Tailscale já está ligado', tailscale: before });
    if (!(await polkitAgent())) {
      return res.status(503).json({
        ok: false, needsAgent: true,
        error: 'Falta um agente de autenticação gráfico (polkit). Instale com: sudo pacman -S hyprpolkitagent',
        command: 'sudo tailscale up'
      });
    }
    try {
      await pkexec(['tailscale', 'up']);
    } catch (e) {
      const err = (e.stderr || e.message || '').toString();
      if (/version|mismatch/i.test(err)) {
        await pkexec(['systemctl', 'restart', 'tailscaled']);
        await new Promise((r) => setTimeout(r, 1500));
        await pkexec(['tailscale', 'up']);
      } else {
        throw e;
      }
    }
    const after = await tailscaleStatus();
    res.json({ ok: true, message: 'Tailscale ligado', tailscale: after });
  } catch (e) {
    const err = (e.stderr || e.message || '').toString().trim();
    res.status(500).json({ ok: false, error: e.killed ? 'Autorização expirou' : (err || 'Falha ao ligar o Tailscale') });
  }
});

app.get('/api/state', (req, res) => {
  if (!state) return res.json({ hasGame: false });
  const flags = state.flags;
  state.flags = [];
  res.json({ hasGame: true, view: game.view(state, req.query.role === 'hand' ? 'hand' : 'table'), flags });
});

app.get('/api/decks', (req, res) => {
  try {
    const found = scanDecks(VAULT);
    const registry = readRegistry(DATA_DIR);
    const db = readDb(DATA_DIR);
    const decks = found.map((d) => {
      const recent = registry.find((r) => r.relPath === d.relPath);
      let suggestion = null;
      try {
        suggestion = suggestBasicCopies(loadDeck(VAULT, d.relPath, db));
      } catch {}
      return {
        relPath: d.relPath,
        name: d.name,
        cardFiles: d.cardFiles,
        lastLoadedAt: recent ? recent.lastLoadedAt : null,
        basicCopies: recent ? recent.basicCopies : null,
        suggestion
      };
    });
    decks.sort((a, b) => (b.lastLoadedAt || 0) - (a.lastLoadedAt || 0));
    res.json({ ok: true, vaultRoot: VAULT, decks });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/card-image', (req, res) => {
  const deckRel = String(req.query.deck || '');
  const fileRel = String(req.query.file || '');
  const deckAbs = path.resolve(VAULT, deckRel);
  const fileAbs = path.resolve(deckAbs, fileRel);
  if (!fileAbs.startsWith(deckAbs + path.sep)) return res.status(400).end();
  if (!/\.(jpe?g|png)$/i.test(fileAbs)) return res.status(400).end();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(fileAbs, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.get('/api/card-back', (req, res) => {
  const rel = config.cardBack ? String(config.cardBack) : '';
  if (!rel) return res.status(404).end();
  const abs = path.resolve(VAULT, rel);
  if (!abs.startsWith(VAULT + path.sep)) return res.status(400).end();
  if (!/\.(jpe?g|png)$/i.test(abs)) return res.status(400).end();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(abs, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.get('/api/qr', async (req, res) => {
  try {
    const text = String(req.query.url || '');
    if (!text.startsWith('http')) return res.status(400).end();
    const buf = await QRCode.toBuffer(text, { width: 320, margin: 1, color: { dark: '#101a12', light: '#f3f0e3' } });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch {
    res.status(500).end();
  }
});

async function loadDeckAndStart(relPath, basicCopies) {
  if (loadInProgress) throw new Error('Já existe um carregamento em andamento');
  loadInProgress = { relPath, startedAt: Date.now(), phase: 'loading', done: 0, total: 0 };
  broadcast('loadProgress', { phase: 'loading', done: 0, total: 0 });

  const abs = path.resolve(VAULT, relPath);
  if (!abs.startsWith(VAULT + path.sep)) throw new Error('Caminho fora do cofre');

  let db = readDb(DATA_DIR);
  let deck = loadDeck(VAULT, relPath, db);
  const missing = deck.cards.filter((c) => !c.meta).map((c) => c.name);

  if (missing.length) {
    loadInProgress.phase = 'scryfall';
    loadInProgress.total = missing.length;
    broadcast('loadProgress', { phase: 'scryfall', done: 0, total: missing.length });
    try {
      await fetchMissing(missing, DATA_DIR, {
        delayMs: config.scryfallDelayMs || 150,
        onProgress: ({ done, total, name }) => {
          loadInProgress.done = done;
          loadInProgress.total = total;
          broadcast('loadProgress', { phase: 'scryfall', done, total, name });
        }
      });
    } catch (e) {
      console.error('Scryfall falhou (seguindo sem metadata):', e.message);
    }
    db = readDb(DATA_DIR);
    deck = loadDeck(VAULT, relPath, db);
  }

  if (basicCopies == null) {
    const reg = readRegistry(DATA_DIR).find((r) => r.relPath === relPath);
    const sug = suggestBasicCopies(deck);
    basicCopies = reg && reg.basicCopies ? reg.basicCopies : sug.copies;
  }

  state = game.createGame({ deck, basicCopies });
  lastDeck = { relPath, name: deck.name, basicCopies };
  past = [];
  upsertRegistry(DATA_DIR, { relPath, name: deck.name, basicCopies, lastLoadedAt: Date.now() });
  loadInProgress = null;
  broadcast('loadProgress', { phase: 'done', done: 1, total: 1 });
  pushState();
  return deck;
}

app.post('/api/decks/clear', (req, res) => {
  try {
    lastDeck = null;
    state = null;
    past = [];
    loadInProgress = null;
    persistSoon();
    broadcast('cleared');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/decks/load', async (req, res) => {
  try {
    const { relPath, basicCopies } = req.body || {};
    if (!relPath) return res.status(400).json({ ok: false, error: 'relPath obrigatório' });
    const deck = await loadDeckAndStart(relPath, basicCopies || null);
    res.json({ ok: true, deck: { name: deck.name, cardCount: deck.cardCount, commanderKey: deck.commanderKey } });
  } catch (e) {
    loadInProgress = null;
    broadcast('loadProgress', { phase: 'error', error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/game/new', (req, res) => {
  try {
    if (!lastDeck) return res.status(400).json({ ok: false, error: 'Nenhum deck carregado' });
    const db = readDb(DATA_DIR);
    const deck = loadDeck(VAULT, lastDeck.relPath, db);
    const basicCopies = (req.body && req.body.basicCopies) || lastDeck.basicCopies || {};
    state = game.createGame({ deck, basicCopies });
    lastDeck.basicCopies = basicCopies;
    past = [];
    pushState();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/action', (req, res) => {
  try {
    const action = req.body || {};
    if (!state) return res.status(400).json({ ok: false, error: 'Nenhuma partida em andamento' });
    if (action.t === 'undo') {
      const r = undo();
      if (r.ok) pushState();
      return res.json(r);
    }
    snapshot();
    const r = game.apply(state, action);
    if (!r.ok) {
      past.pop();
      return res.status(400).json(r);
    }
    pushState();
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

loadPersistedGame();

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ⚔  Mesa Commander');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Cofre:  ${VAULT}`);
  console.log(`  Local:  http://localhost:${PORT}`);
  for (const a of networkAddresses()) {
    console.log(`  Rede:   http://${a.address}:${PORT}  (${a.iface})`);
  }
  if (state) console.log(`  Partida em andamento: ${state.deckName}`);
  console.log('  ─────────────────────────────────────────────');
  console.log('  No celular: abra o endereço de Rede → papel "Mão".');
  console.log('  Fora de casa: tailscale up e use o IP/hostname do Tailscale.');
  console.log('');
});

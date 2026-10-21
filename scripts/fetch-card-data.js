#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { scanDecks, loadDeck } = require('../lib/deck');
const { fetchMissing } = require('../lib/scryfall');

async function main() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  } catch (e) {
    console.error('config.json não encontrado. Copie config.example.json para config.json e ajuste "vaultRoot".');
    process.exit(1);
  }
  const vaultRoot = process.env.VAULT_ROOT || config.vaultRoot;
  if (!vaultRoot || !fs.existsSync(vaultRoot)) {
    console.error(`Pasta do cofre não encontrada: ${vaultRoot || '(vazio)'}. Ajuste "vaultRoot" no config.json.`);
    process.exit(1);
  }
  const dataDir = path.join(__dirname, '..', 'data');
  const decks = scanDecks(vaultRoot);
  console.log(`Decks encontrados no cofre: ${decks.length}`);
  const allNames = new Set();
  for (const d of decks) {
    try {
      const deck = loadDeck(vaultRoot, d.relPath);
      deck.cards.forEach((c) => allNames.add(c.name));
      console.log(`  - ${d.relPath}: ${deck.cardCount} cartas${deck.commanderKey ? `, comandante: ${deck.commanderKey}` : ', SEM comandante detectado'}`);
    } catch (e) {
      console.log(`  - ${d.relPath}: ERRO ${e.message}`);
    }
  }
  console.log(`\nBuscando metadados de ${allNames.size} cartas unicas na Scryfall...`);
  const { fetched, failed } = await fetchMissing([...allNames], dataDir, {
    delayMs: config.scryfallDelayMs || 150,
    onProgress: ({ done, total, name }) => process.stdout.write(`\r  ${done}/${total} ${name.padEnd(50)}`)
  });
  console.log(`\nPronto: ${fetched} buscadas, ${failed.length} nao encontradas${failed.length ? ': ' + failed.join(', ') : ''}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

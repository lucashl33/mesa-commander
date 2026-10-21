# Mesa Commander

Mesa virtual para jogar **Magic: The Gathering – Commander solo** usando as imagens das cartas que você já tem no computador. O **computador** vira a mesa (campo, vida, mana, pilhas) e o **celular** vira a sua mão — os dois ficam sincronizados em tempo real.

- **Visão Mesa** (computador): campo com as cartas, vida/mana, pilhas (biblioteca, cemitério, banido, pilha, comando), fases do turno e log.
- **Visão Mão** (celular): suas cartas da mão, com ações (jogar no campo, descartar, virar, etc.).
- Sincronização instantânea via WebSocket: o que você faz no celular aparece no computador e vice-versa.
- Arraste cartas livremente pelo campo, empilhe, gire para o oponente, adicione marcadores, tokens e muito mais.
- Sem build, sem framework: roda com Node.js puro e abre no navegador.

---

## Requisitos

- **Node.js 18+** (testado no 26). Confira com `node -v`.
- As imagens das suas cartas num computador. Cada **deck** é uma pasta com os arquivos de imagem das cartas (`.jpg` ou `.png`).
- Um celular na **mesma rede Wi-Fi** do computador (para usar a visão Mão).

---

## Instalação

```bash
git clone <url-do-seu-repositorio> mesa-commander
cd mesa-commander
npm install
```

Depois de instalar, crie o arquivo de configuração:

```bash
cp config.example.json config.json
```

Abra o `config.json` e ajuste o campo `vaultRoot` para a pasta onde estão os seus decks:

```json
{
  "port": 3000,
  "vaultRoot": "/home/seu-usuario/Documents/Cartas",
  "cardBack": "",
  "scryfallDelayMs": 150
}
```

### Como organizar suas cartas

O app **descobre os decks automaticamente** dentro da pasta `vaultRoot`. Uma pasta é reconhecida como deck quando contém **pelo menos 5 imagens** (ou subpastas com imagens) de cartas. Você pode ter várias pastas aninhadas — cada uma vira um deck selecionável.

Exemplo:

```
Cartas/
├── Deck-Ajani/
│   ├── 00_COMMANDER_Ajani.jpg
│   ├── 1 Criaturas/
│   │   ├── Soldado.jpg
│   │   └── ...
│   ├── 2 Feitiços/
│   └── 6 Terrenos/
└── Deck-Chandra/
    └── ...
```

Dicas:
- Nomeie o comandante com `commander` ou `comandante` no nome do arquivo (ex.: `00_COMMANDER_Nome.jpg`) para que ele seja detectado como comandante.
- Os nomes de tipo (Criaturas, Terrenos, Feitiços, etc.) são usados só para classificar; o nome do arquivo de imagem é o nome da carta.

---

## Rodando

```bash
npm start
```

No terminal vai aparecer algo assim:

```
  ⚔  Mesa Commander
  ─────────────────────────────────────────────
  Cofre:  /home/seu-usuario/Documents/Cartas
  Local:  http://localhost:3000
  Rede:   http://192.168.0.10:3000  (wlan0)
  ─────────────────────────────────────────────
  No celular: abra o endereço de Rede → papel "Mão".
```

1. No **computador**, abra `http://localhost:3000` e escolha **Mesa**.
2. Escolha um deck e comece a partida.
3. No **celular**, abra o endereço de **Rede** mostrado no terminal (ex.: `http://192.168.0.10:3000`) e escolha **Mão**. A tela inicial tem um **QR code** que você pode escanear direto do computador.

### Usar fora de casa (4G)

Para jogar quando o celular e o computador não estiverem na mesma rede, instale o [Tailscale](https://tailscale.com) nos dois e pronto: a tela inicial mostra um segundo QR code com o endereço do Tailscale, que funciona por 4G.

---

## Metadados das cartas (opcional, mas recomendado)

Para mostrar custo de mana, cores e sugestões de terrenos básicos, o app busca os dados das cartas na API pública da Scryfall. Para baixar tudo de uma vez:

```bash
npm run fetch-cards
```

Isso popula `data/cards-db.json` com os metadados das cartas dos seus decks. Sem isso o app funciona, mas com ajuda automática reduzida (custo de mana, cores, etc.).

---

## Configuração (config.json)

| Campo             | Descrição                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `port`            | Porta do servidor (padrão `3000`).                                                            |
| `vaultRoot`       | Pasta raiz onde estão os seus decks. O app procura por decks aqui dentro.                     |
| `cardBack`        | (Opcional) Caminho, relativo ao `vaultRoot`, de uma imagem para o **verso** das cartas viradas para baixo. Ex.: `"verso/carta-tras.jpg"`. Se vazio, usa um verso padrão. |
| `scryfallDelayMs` | Intervalo entre chamadas à Scryfall (padrão `150`, não diminua para não ser bloqueado).       |

Você também pode usar **variáveis de ambiente**: `PORT`, `VAULT_ROOT` e `MTG_DATA_DIR`.

---

## Testes

```bash
npm test
```

---

## Estrutura do projeto

```
server.js              Servidor HTTP + WebSocket + API
lib/
  deck.js              Descoberta e carregamento de decks
  game.js              Regras e estado do jogo (turnos, zonas, ações)
  scryfall.js          Cache de metadados das cartas
public/
  index.html           Página única do app
  app.js               Frontend (visões Mesa e Mão)
  style.css            Estilo
scripts/
  fetch-card-data.js   Baixa metadados das cartas
data/                  Estado salvo e cache (gerado, não versionado)
config.json            Sua configuração (não versionado)
config.example.json    Modelo de configuração
```

---

## Licença

MIT — use, modifique e compartilhe à vontade.

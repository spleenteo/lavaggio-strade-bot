# 🧹 Bot Lavaggio Strade — versione Cloudflare Workers

Bot Telegram che, quando gli condividi la **posizione**, ti dice se in quella via
è previsto **oggi** il lavaggio/spazzamento strade. Gira su **Cloudflare Workers**
(serverless, sempre attivo, piano gratuito) con i dati in **Cloudflare KV**.

Dati: **open data "Pulizia Strade" del Comune di Firenze** (fonte Alia).

> ⚠️ Copre **solo il Comune di Firenze città**. Fa sempre fede il **cartello in strada**.

---

## Come funziona (architettura)

```
                 (1) build+push, periodico
   KMZ Comune ─────────────────────────────► Cloudflare KV  (dati "pre-digeriti")
                                                    ▲
Telegram ──POST webhook──► Cloudflare Worker ───────┘  legge, trova la via, risponde
   ▲                             │
   └──────── sendMessage ────────┘
```

- Il **Worker** (`src/worker.js`) è minuscolo e senza dipendenze: riceve il
  messaggio, trova la via più vicina e risponde.
- I **dati** non si scaricano a ogni messaggio: uno script (`npm run build:data`)
  scarica il KMZ e lo trasforma in un JSON compatto con geometrie + calendario già
  interpretato; poi lo carichi su KV (`npm run push:data`). Il Worker legge solo quello.
- L'aggiornamento periodico si fa a mano ogni tanto, **oppure** in automatico con la
  GitHub Action inclusa.

---

## Cosa ti serve

- **Node.js 18+** sul computer.
- Un account **Cloudflare** (gratuito).
- Un **token** del bot da **@BotFather** su Telegram.

## Setup passo-passo

Tutti i comandi si lanciano dalla cartella del progetto.

**1) Installa le dipendenze**
```bash
npm install
```

**2) Crea il bot Telegram**
Su Telegram scrivi a **@BotFather** → `/newbot` → scegli nome e username (deve finire
per `bot`). Copia il **token** che ti dà.

**3) Collega Cloudflare**
```bash
npx wrangler login
```
(si apre il browser per autorizzare)

**4) Crea lo spazio dati KV**
```bash
npx wrangler kv namespace create STREETS_KV
```
Copia l'`id` che viene stampato e incollalo in **`wrangler.toml`** al posto di `<KV_ID>`.

**5) Genera i dati e caricali su KV**
```bash
npm run build:data     # scarica il KMZ e crea data/pulizia_strade.json
npm run push:data      # carica quel file su Cloudflare KV
```

**6) Imposta i segreti del Worker**
```bash
npx wrangler secret put BOT_TOKEN        # incolla il token di BotFather
npx wrangler secret put WEBHOOK_SECRET   # inventa una stringa segreta (es. una password lunga)
```

**7) Pubblica il Worker**
```bash
npm run deploy
```
A fine deploy vedi l'URL pubblico, del tipo
`https://lavaggio-strade-bot.TUO-SUBDOMINIO.workers.dev`. Copialo.

**8) Registra il webhook su Telegram**
```bash
BOT_TOKEN="il-token" \
WEBHOOK_SECRET="la-stessa-stringa-del-punto-6" \
WORKER_URL="https://lavaggio-strade-bot.TUO-SUBDOMINIO.workers.dev" \
npm run set-webhook
```
Se vedi `"ok": true` sei online.

**9) Prova**
Apri la chat con il tuo bot, `/start`, poi 📎 → **Posizione**. 🎉

### Condividerlo con un'altra persona
Passa lo **username del bot**: funziona per entrambi, sempre, senza tenere acceso il
tuo PC (gira su Cloudflare).

---

## Aggiornare i dati

Il Comune aggiorna il calendario ogni tanto. Per rinfrescare i dati:

**A mano** (semplice): riesegui
```bash
npm run build:data && npm run push:data
```

**In automatico** (consigliato): usa la GitHub Action inclusa
(`.github/workflows/refresh-data.yml`), che ogni lunedì rigenera e ricarica i dati.
Va messo il progetto su un repo GitHub e configurati due *Secrets* nel repo
(Settings → Secrets and variables → Actions):
- `CLOUDFLARE_API_TOKEN` — token con permesso *Workers KV Storage: Edit*
- `CLOUDFLARE_ACCOUNT_ID` — l'id del tuo account Cloudflare

Il Worker rilegge i dati aggiornati entro breve (la cache in memoria si azzera a ogni
nuovo "risveglio" dell'isolate).

---

## Sviluppo in locale (opzionale)

```bash
cp .dev.vars.example .dev.vars      # inserisci BOT_TOKEN e WEBHOOK_SECRET
npm run build:data
npm run push:data:local             # carica i dati nella KV locale
npm run dev                         # avvia il Worker in locale
```

Test della logica (senza rete):
```bash
npm test
```

---

## Struttura del progetto

```
src/
  worker.js         entry del Worker: webhook, comandi, risposta
  geo.js            distanza punto→via (JS puro, niente dipendenze)
  schedule-core.js  parsing e decisione del calendario (condiviso build/worker)
  reply.js          messaggio Telegram in HTML
scripts/
  build-data.mjs    KMZ → data/pulizia_strade.json (compatto, pre-digerito)
  set-webhook.mjs   registra/rimuove il webhook Telegram
wrangler.toml       config Cloudflare (nome, KV, variabili)
.github/workflows/  refresh automatico dei dati
test/               test di fumo
```

## Note

- **Precisione del calendario:** il formato del testo nel dataset non è documentato,
  quindi il parser dei giorni è "best effort". Il bot mostra **sempre anche il testo
  ufficiale grezzo**: se un caso viene letto male, mandami un paio di esempi e affino
  le regole in `src/schedule-core.js`.
- **Un altro comune?** Cambia `DATA_URL` (variabile d'ambiente per `build:data`) con
  un dataset equivalente. Dimmi quale comune e cerco la fonte.
- **Sicurezza:** il Worker accetta solo POST con l'header segreto corretto
  (`WEBHOOK_SECRET`), così nessun altro può pilotare il bot.
- **Licenza dati:** CC-BY-NC-SA 4.0 — Comune di Firenze (fonte Alia). Uso personale ok.

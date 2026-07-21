# 🧹 Bot Lavaggio Strade — versione Cloudflare Workers

Bot Telegram che dice quando è prevista la **prossima finestra** di
lavaggio/spazzamento strade per un tratto di Firenze: condividi la
**posizione**, oppure scrivi il **nome della via**. La finestra può essere
**notturna (00:00–06:00)** o **diurna**: il bot calcola sempre la prossima,
qualunque sia l'ora del giorno, in fuso **Europe/Rome**. Gira su
**Cloudflare Workers** (serverless, sempre attivo, piano gratuito) con i dati
in **Cloudflare KV**.

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
  messaggio — posizione o testo — trova il tratto o la via corrispondente e
  risponde (bottoni inline se il nome scritto è ambiguo).
- I **dati** non si scaricano a ogni messaggio: uno script (`npm run build:data`)
  scarica il KMZ e lo trasforma in un JSON compatto con geometrie + calendario già
  interpretato; poi lo carichi su KV (`npm run push:data`). Il Worker legge solo quello.
- L'aggiornamento periodico si fa a mano ogni tanto, **oppure** in automatico con la
  GitHub Action inclusa.

### Cosa risponde

- **Posizione** → il tratto di via più vicino (entro 60 m), con la prossima
  finestra di lavaggio ("STANOTTE 00:00–06:00", "OGGI 13:00–18:00", "⚠️ IN
  CORSO ORA" se sei dentro la finestra, o la data futura) e quella successiva.
- **Nome della via** (es. `via masaccio`) → tutti i tratti della via,
  accorpati per calendario; se più vie corrispondono compaiono dei bottoni.
- Il lavaggio può essere **notturno (00:00–06:00) o diurno**: il bot considera
  entrambi. Alcuni tratti (~290 su 1801) hanno calendario "pari/dispari": è
  la **parità della data del mese** (es. «giovedì pari» = i giovedì che
  cadono il 2, 16, 30…), non la settimana — semantica verificata (56/56) con
  il lookup ufficiale Alia il 2026-07-21, vedi spec di design. Fa comunque
  sempre fede il cartello in strada.

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

> ⚠️ **Upgrade dalla v1:** il Worker v2 richiede dati in formato v2 (ogni tratto con
> `schedule` strutturato). Se in KV c'è ancora un blob v1, il Worker rifiuta di
> partire con un errore esplicito ("formato vecchio"). Esegui sempre `npm run
> push:data` **prima** di `npm run deploy`, così il Worker aggiornato trova già
> i dati nel formato che si aspetta.

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
  worker.js          entry del Worker: webhook, comandi (/start, /info),
                     posizione, ricerca per via, bottoni inline
  geo.js             distanza punto→via (JS puro, niente dipendenze)
  schedule-core.js   fuso Europe/Rome + nextWindow() — condiviso build/worker,
                     PURO (nessuna dipendenza)
  search.js          ricerca vie per nome: normalizzazione, punteggio
                     esatto/prefisso/sottostringa/fuzzy — PURO
  parse-dataset.js   estrazione dei campi strutturati dal dataset KML — usato
                     solo in build
  reply.js           messaggi Telegram in HTML (prossima finestra, dettaglio
                     tratto, vista via)
scripts/
  build-data.mjs     KMZ → data/pulizia_strade.json (compatto, pre-digerito)
  set-webhook.mjs    registra/rimuove il webhook Telegram
wrangler.toml        config Cloudflare (nome, KV, variabili)
.github/workflows/   refresh automatico dei dati
test/                test automatici (node --test)
```

## Note

- **Precisione del calendario:** il parser legge i **campi strutturati** del
  dataset KML (`giorno_settimana`, `prima…quinta_settimana`, `pari`/`dispari`,
  `ora_inizio`/`ora_fine`), non prosa libera. La build **fallisce** con errore
  esplicito se il formato upstream cambia (copertura di parsing sotto il 90%
  dei record, o vie uniche sotto 500): meglio un errore in build che dati
  sbagliati silenziosi. Il bot mostra comunque sempre anche il testo
  **ufficiale grezzo** nel dettaglio del tratto.
- **Un altro comune?** Cambia `DATA_URL` (variabile d'ambiente per `build:data`) con
  un dataset equivalente. Dimmi quale comune e cerco la fonte.
- **Sicurezza:** il Worker accetta solo POST con l'header segreto corretto
  (`WEBHOOK_SECRET`), così nessun altro può pilotare il bot.
- **Licenza dati:** CC-BY-NC-SA 4.0 — Comune di Firenze (fonte Alia). Uso personale ok.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Cos'è

Bot Telegram su **Cloudflare Workers**: l'utente condivide la posizione e il bot risponde se in quella via è previsto **oggi** il lavaggio/spazzamento strade. Fonte: open data "Pulizia Strade" del Comune di Firenze (KMZ, fornitore Alia). Copre **solo Firenze città**. Interfaccia e messaggi sono in **italiano**.

## Comandi

```bash
npm run build:data          # KMZ → data/pulizia_strade.json (gira in Node, usa adm-zip/xmldom/togeojson)
npm run push:data           # carica il JSON su KV remoto (binding STREETS_KV)
npm run push:data:local     # come sopra ma su KV locale (per `npm run dev`)
npm run deploy              # wrangler deploy
npm run dev                # wrangler dev (Worker in locale)
npm run set-webhook        # registra il webhook Telegram (vedi variabili sotto)
npm test                   # test di fumo (node test/smoke.test.mjs, nessun framework)
```

- `set-webhook` legge `BOT_TOKEN`, `WORKER_URL`, `WEBHOOK_SECRET` dall'ambiente; `node scripts/set-webhook.mjs delete` rimuove il webhook.
- `override` della sorgente dati: `DATA_URL=... npm run build:data` (per puntare a un altro comune/dataset).
- **Test**: c'è un unico file `test/smoke.test.mjs` senza test runner — non esiste un "run a single test", si esegue tutto. Per un caso isolato, commenta le sezioni o scrivi uno snippet `node` che importa da `src/`.

## Architettura (il punto chiave)

Il sistema è diviso in **due tempi** che non condividono runtime:

1. **Build-time** (Node, `scripts/build-data.mjs`): scarica il KMZ, lo converte in GeoJSON, **pre-digerisce** ogni via in `{ name, lines, bbox, weekdays, ordinals, times, raw }` e scrive `data/pulizia_strade.json`. Qui il **parsing del calendario avviene una volta sola** (`parseProps`), non a ogni messaggio. Può usare dipendenze Node pesanti.
2. **Runtime** (Cloudflare Worker, `src/worker.js`): riceve l'update Telegram via webhook, legge i dati da KV, trova la via più vicina e **decide** con `decide(parsed, oggi)`. Deve restare **senza dipendenze**: gira in un isolate Workers, non in Node.

Flusso dati: `KMZ Comune → build-data.mjs → data/pulizia_strade.json → KV (chiave "pulizia_strade") → Worker`.

### Vincoli da non violare

- **`src/geo.js` e `src/schedule-core.js` sono codice PURO condiviso tra build e Worker**: niente import di moduli Node o dipendenze. Le librerie come `adm-zip`, `@xmldom/xmldom`, `@tmcw/togeojson` stanno **solo** in `scripts/build-data.mjs`. Se aggiungi codice usato dal Worker, tienilo dependency-free.
- **Separazione parse/decide** in `schedule-core.js`: `parseProps` (→ `weekdays`/`ordinals`/`times`/`raw`) gira in build; `decide` gira nel Worker. Non spostare il parsing a runtime.
- **Formattazione date fatta a mano** (`src/reply.js`): niente `toLocaleDateString('it-IT')` — Workers non garantisce i dati locale ICU italiani. Nomi di mesi/giorni sono array hardcoded.
- **Cache in memoria dell'isolate** (`DATA_CACHE` in `worker.js`): i dati KV si rileggono solo al primo messaggio dopo un "risveglio" dell'isolate. Dopo un nuovo `push:data`, l'aggiornamento si propaga quando l'isolate viene riciclato.
- **Il Worker risponde subito 200** e processa in `ctx.waitUntil(...)`: Telegram non ritenta, quindi il lavoro va fatto in background dopo aver già chiuso la risposta.

### File per ruolo

| File | Ruolo |
|------|-------|
| `src/worker.js` | Entry del Worker: routing webhook, comandi (`/start`, `/info`), gestione posizione, chiamate a Telegram, cache KV, check `WEBHOOK_SECRET`. |
| `src/geo.js` | Geometria pura: via più vicina a un punto. Proiezione equirettangolare locale + pruning via lower-bound sul `bbox`. |
| `src/schedule-core.js` | Parsing "best effort" del testo calendario (build) e `decide` su una data (runtime). |
| `src/reply.js` | Costruzione del messaggio Telegram in HTML (escaping, formattazione date). |

## Config e segreti

- `wrangler.toml`: contiene il placeholder **`<KV_ID>`** che va sostituito con l'id reale del namespace (`npx wrangler kv namespace create STREETS_KV`). Var pubblica `MATCH_THRESHOLD_M` (default 60 m).
- Segreti **non** in `wrangler.toml`: `BOT_TOKEN` e `WEBHOOK_SECRET` via `npx wrangler secret put ...`. Il Worker rifiuta con 403 le POST senza header `x-telegram-bot-api-secret-token` corretto.

## Note sullo stato del repo

- Non è (ancora) un repo git. `data/` è **vuota**: `data/pulizia_strade.json` va generato con `build:data` prima di `push:data`, `dev` o `test`.
- Il README cita `.github/workflows/refresh-data.yml` (Action settimanale) e `.dev.vars.example`: al momento **non sono presenti nel repo**. Se servono, vanno creati.
- Il formato del testo calendario nel dataset non è documentato: il parser in `schedule-core.js` è "best effort" e il bot mostra sempre anche il `raw` ufficiale. Affinare le regolari lì quando emergono letture sbagliate.

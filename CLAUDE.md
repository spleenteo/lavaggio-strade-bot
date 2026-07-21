# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Cos'è

Bot Telegram su **Cloudflare Workers**: l'utente condivide la **posizione** oppure scrive il **nome di una via**, e il bot risponde con la **prossima finestra** di lavaggio/spazzamento strade (notturna 00:00–06:00 o diurna) del tratto corrispondente, più quella successiva. Fonte: open data "Pulizia Strade" del Comune di Firenze (KMZ, fornitore Alia). Copre **solo Firenze città**. Interfaccia e messaggi sono in **italiano**.

## Comandi

```bash
npm run build:data          # KMZ → data/pulizia_strade.json (gira in Node, usa adm-zip/xmldom/togeojson)
npm run push:data           # carica il JSON su KV remoto (binding STREETS_KV)
npm run push:data:local     # come sopra ma su KV locale (per `npm run dev`)
npm run deploy              # wrangler deploy
npm run dev                # wrangler dev (Worker in locale)
npm run set-webhook        # registra il webhook Telegram (vedi variabili sotto)
npm test                   # node --test 'test/**/*.test.mjs' — runner nativo Node, zero dipendenze
```

- `set-webhook` legge `BOT_TOKEN`, `WORKER_URL`, `WEBHOOK_SECRET` dall'ambiente; `node scripts/set-webhook.mjs delete` rimuove il webhook.
- `override` della sorgente dati: `DATA_URL=... npm run build:data` (per puntare a un altro comune/dataset).
- **Test**: 5 file in `test/` (`parse`, `schedule`, `search`, `reply`, `worker`), 38 test totali, tutti con `node:test`/`node:assert` nativi. Per un caso isolato: `node --test test/schedule.test.mjs`, oppure `node --test --test-name-pattern="nextWindow"` per filtrare per nome.

## Architettura (il punto chiave)

Il sistema è diviso in **due tempi** che non condividono runtime:

1. **Build-time** (Node, `scripts/build-data.mjs`): scarica il KMZ, lo converte in GeoJSON, estrae i **campi strutturati** della description (`src/parse-dataset.js`: `extractFields` + `parseSchedule`) e **pre-digerisce** ogni tratto in `{ via, viaId, searchName, tratto, schedule: {weekday, weeks, parity, start, end}, lines, bbox, raw }`, poi scrive `data/pulizia_strade.json`. Qui il **parsing del calendario avviene una volta sola**, non a ogni messaggio. La build **fallisce rumorosamente** (`process.exit(1)`) se le vie uniche sono < 500 o la copertura di parsing è < 90%: meglio un errore in build che dati sbagliati silenziosi. Può usare dipendenze Node pesanti.
2. **Runtime** (Cloudflare Worker, `src/worker.js`): riceve l'update Telegram via webhook, legge i dati da KV, trova il tratto più vicino (`src/geo.js`) o cerca per nome (`src/search.js`) e calcola la **prossima finestra** con `nextWindow(schedule, now)` (`src/schedule-core.js`). Deve restare **senza dipendenze**: gira in un isolate Workers, non in Node.

Flusso dati: `KMZ Comune → build-data.mjs (parse) → data/pulizia_strade.json → KV (chiave "pulizia_strade") → Worker (nextWindow a runtime)`.

### Vincoli da non violare

- **`src/geo.js`, `src/schedule-core.js` e `src/search.js` sono codice PURO condiviso tra build e Worker**: niente import di moduli Node o dipendenze. Le librerie come `adm-zip`, `@xmldom/xmldom`, `@tmcw/togeojson` stanno **solo** in `scripts/build-data.mjs`. `src/parse-dataset.js` è puro ma usato solo in build (non serve al Worker). Se aggiungi codice usato dal Worker, tienilo dependency-free.
- **Parse in build, decide a runtime**: l'estrazione dei campi (`parse-dataset.js`, → `schedule` strutturato) gira **solo** in `build-data.mjs`; `nextWindow` (in `schedule-core.js`) gira **solo** nel Worker, su uno `schedule` già pronto letto da KV. Non spostare il parsing del dataset a runtime, non spostare `nextWindow` in build.
- **Fuso orario Europe/Rome via `Intl`, mai date locali dirette**: i Workers girano in UTC, `new Date()`/`getDate()` locali darebbero il giorno sbagliato. `schedule-core.js` usa `Intl.DateTimeFormat(..., { timeZone: 'Europe/Rome' })` (`romeParts`/`romeDate`) per ogni conversione locale↔assoluto; le date di calendario pure (`{y,m,d}`) si sommano in UTC-mezzogiorno (`addDays`) per evitare bug di DST.
- **Formattazione date fatta a mano** (`src/reply.js`): niente `toLocaleDateString('it-IT')` — Workers non garantisce i dati locale ICU italiani. Nomi di mesi/giorni sono array hardcoded (`WEEKDAY_LABEL`, `MONTHS` in `schedule-core.js`).
- **Cache in memoria dell'isolate** (`CACHE` in `worker.js`, contiene `{ data, streets }`): i dati KV si rileggono solo al primo messaggio dopo un "risveglio" dell'isolate. Dopo un nuovo `push:data`, l'aggiornamento si propaga quando l'isolate viene riciclato.
- **Il Worker risponde subito 200** e processa in `ctx.waitUntil(...)`: Telegram non ritenta, quindi il lavoro va fatto in background dopo aver già chiuso la risposta.

### File per ruolo

| File | Ruolo |
|------|-------|
| `src/worker.js` | Entry del Worker: routing webhook, comandi (`/start`, `/info`), posizione, ricerca testuale, bottoni inline (`callback_query`), chiamate a Telegram, cache KV, check `WEBHOOK_SECRET`. |
| `src/geo.js` | Geometria pura: tratto più vicino a un punto. Proiezione equirettangolare locale + pruning via lower-bound sul `bbox`. |
| `src/schedule-core.js` | Utilità di fuso Europe/Rome (`romeParts`, `romeDate`, `addDays`, `isoWeek`) e `nextWindow(schedule, now)`: prossima finestra di lavaggio su un orizzonte di 90 giorni. |
| `src/search.js` | Ricerca vie per nome: normalizzazione (`normalizeName`), indice per via (`buildIndex`), punteggio esatto/prefisso/sottostringa/fuzzy (Levenshtein) in `searchStreets`/`closestStreets`. |
| `src/parse-dataset.js` | Estrazione dei campi strutturati dalla description KML (`extractFields`, `parseSchedule`, `officialRaw`) — usato solo in build. |
| `src/reply.js` | Costruzione dei messaggi Telegram in HTML: dettaglio tratto (`buildTrattoReply`), vista via accorpata per calendario (`buildStreetReply`), etichetta finestra (`windowLabel`: STANOTTE / OGGI / domani / data futura / IN CORSO ORA). |

## Config e segreti

- `wrangler.toml`: contiene il placeholder **`<KV_ID>`** che va sostituito con l'id reale del namespace (`npx wrangler kv namespace create STREETS_KV`). Var pubblica `MATCH_THRESHOLD_M` (default 60 m).
- Segreti **non** in `wrangler.toml`: `BOT_TOKEN` e `WEBHOOK_SECRET` via `npx wrangler secret put ...`. Il Worker rifiuta con 403 le POST senza header `x-telegram-bot-api-secret-token` corretto.

## Note sullo stato del repo

- Il repo è tracciato con git, remote `origin` → `git@github.com:spleenteo/lavaggio-strade-bot.git`. Sviluppo v2 sul branch `v2` (da `main`, che contiene solo lo stato iniziale v1).
- `data/pulizia_strade.json` è gitignored (`data/*.json` in `.gitignore`): va generato in locale con `npm run build:data` prima di `push:data` o `dev`. **Non serve** per `npm test`: i test usano fixture inline, non leggono `data/`.
- Il README cita `.github/workflows/refresh-data.yml` (Action settimanale) e `.dev.vars.example`: al momento **non sono presenti nel repo**. Se servono, vanno creati.
- Sul dataset: il campo `pari`/`dispari` (~290 record su 1801) è interpretato come settimana ISO dell'anno; la verifica online (Task 8, vedi spec di design) **non ha confermato con certezza** questa ipotesi né l'alternativa "settimana del mese" — nessuna delle due modella bene i dati osservati sul lookup ufficiale Alia. Nessuna modifica al codice: mitigazione invariata (`raw` sempre visibile + disclaimer cartello in ogni risposta).

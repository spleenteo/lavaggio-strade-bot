# Bot Lavaggio Strade v2 — Design

**Data:** 2026-07-21 · **Stato:** approvato a voce, in attesa di review scritta

## Obiettivo

Evolvere il bot Telegram (Cloudflare Workers) da "posizione → c'è lavaggio oggi?" a:

1. Interrogazione **anche per indirizzo scritto a mano** (ricerca sui dati open data Comune di Firenze / fonte Alia).
2. Semantica corretta: risposta sulla **prossima finestra di lavaggio** del tratto (notturna 00:00–06:00 *o diurna*), più la finestra successiva.
3. Parsing del calendario dai **campi strutturati** del dataset (il parser attuale a regex su prosa riconosce **0 vie su 1802**: bug critico scoperto durante il brainstorming).

**Copertura:** solo Firenze città (decisione esplicita; estensione ad altri comuni Alia fuori scope).

## Decisioni di prodotto (dal brainstorming)

| Tema | Decisione |
|---|---|
| Semantica temporale | Prossima finestra del tratto + finestra successiva ("stanotte SÌ/NO" + "prossimo lavaggio: …"). Query durante la finestra → "in corso ORA". |
| Fasce diurne (46% dei tratti) | Trattate al pari delle notturne: il bot risponde sempre sulla prossima finestra, qualunque sia l'orario. |
| Vie multi-tratto (187, di cui 175 con calendari diversi) | Un solo messaggio con tutti i tratti, accorpati per calendario identico, ordinati per urgenza. Nessuna scelta interattiva del tratto. |
| Più vie candidate alla ricerca | Bottoni inline (max 6), `callback_data = codice_via`. |
| Copertura | Solo Firenze città. |

## Fatti sul dataset (rilevati il 2026-07-21)

- 1802 record (tratti), 1527 vie uniche, tutti `comune: FIRENZE`, tutti `tipo_record: I`.
- Campi strutturati nella description KML: `indirizzo`, `codice_via`, `tratto_strada`, `giorno_settimana` (LU/MA/ME/GI/VE/SA/DO), `prima…quinta_settimana` (flag 0/1), `pari`/`dispari`, `ora_inizio`/`ora_fine`, `notturno`, `settimanale`.
- Orari: 976 record 00:00–06:00 (notturni), 826 diurni con ~37 fasce diverse.
- `pari`/`dispari` (143/147 record): compaiono **solo** con flag settimane `11111`, mai entrambi sullo stesso tratto. **Ipotesi di lavoro:** settimane pari/dispari dell'anno (ISO). Da verificare (vedi Rischi).
- `settimanale` e `notturno`: ridondanti, non si salvano.
- Semantica flag settimana: "n-esima occorrenza del giorno nel mese" = `ceil(giorno_del_mese / 7)`.

## Architettura

Invariata nei fondamenti: **build Node → JSON su KV (chiave `pulizia_strade`) → Worker puro senza dipendenze**, cache per-isolate, webhook con secret. Cambiano i contenuti dei moduli.

### 1. Modello dati e build (`scripts/build-data.mjs`)

Ogni record del blob è un **tratto**:

```js
{
  via: "VIA MASACCIO",              // campo `indirizzo` originale
  viaId: 9800,                      // `codice_via` — id stabile della via
  searchName: "via masaccio",       // normalizzato in build: minuscole, senza accenti, spazi collassati
  tratto: "DA MIRANDOLA A LA FARINA",
  schedule: {
    weekday: 4,                     // 0=dom … 6=sab
    weeks: [4],                     // settimane del mese attive (1–5)
    parity: null,                   // null | 'even' | 'odd'
    start: "00:00", end: "06:00",   // ora locale Europe/Rome
  },
  lines: [[[lon,lat],…]], bbox: […],
  raw: "…",                         // solo i campi ufficiali, senza righe di stile KML
}
```

- **Merge**: feature con stessi (`viaId`, `tratto`, `schedule`) si fondono in un'unica entry con più `lines`.
- **Validazione in build (fail rumoroso)**: build fallisce se vie uniche < 500 o se i record con `weekday` riconosciuto sono < 90%. Stampa statistiche di copertura del parsing.
- Restano `generatedAt`, `source`, `license` a livello di blob.

### 2. Motore calendario (`src/schedule-core.js`, riscritto)

Primitiva unica:

```js
nextWindow(schedule, now) → { start: Date, end: Date, ongoing: boolean } | null
```

- Itera **date di calendario locali Europe/Rome** (rappresentate come {y,m,d} con aritmetica di calendario, *non* timestamp +24h: sicurezza DST), orizzonte 90 giorni.
- Match del giorno: weekday + flag settimana-del-mese + parità settimana ISO (se presente).
- Primo giorno con finestra `end > now` → risultato; `ongoing = start ≤ now`.
- Conversione locale→istante assoluto tramite offset ricavato con `Intl.DateTimeFormat` e `timeZone: 'Europe/Rome'` (disponibile sui Workers, nessuna dipendenza).
- La risposta usa due chiamate: prossima finestra, poi `nextWindow(schedule, end_della_prima)`.
- Nomi italiani di giorni/mesi restano hardcoded (nessun affidamento sui dati locale ICU it-IT).
- Corregge il **bug di fuso latente** della v1 (`new Date()` in UTC: alle 23:30 UTC il "giorno" a Firenze è già quello dopo).

### 3. UX del Worker (`src/worker.js`, `src/reply.js`)

**Ingressi:**

1. **Posizione** → `nearest()` (invariato, soglia `MATCH_THRESHOLD_M` 60 m) → risposta *dettaglio singolo tratto*: via + tratto, prossima finestra (con enfasi: "in corso ORA" / "stanotte" / "oggi H–H" / data futura), finestra successiva, `raw` ufficiale. Se la via ha altri tratti con calendari diversi: riga "ℹ️ Altri tratti di questa via hanno orari diversi — scrivi *«nome via»* per vederli tutti."
2. **Testo libero** → ricerca: normalizzazione query, scoring su `searchName` (esatto > prefisso > sottostringa > fuzzy con distanza di edit ≤ 2 per token).
   - 1 via → risposta *raggruppata multi-tratto*: tratti accorpati per calendario identico, sezioni ordinate per inizio della prossima finestra crescente (le finestre in corso, con inizio nel passato, vengono naturalmente prime), senza `raw` (resta il disclaimer sul cartello).
   - 2–6 vie → bottoni inline (`callback_data = codice_via`); tap → risposta raggruppata + `answerCallbackQuery`.
   - >6 vie → le 6 migliori + invito ad affinare. 0 vie → i 3 nomi con distanza di edit minima *senza* soglia, come bottoni ("Forse intendevi…").
3. **Comandi**: `/start` (guida: posizione *oppure* nome via), `/info` (vie, tratti, copertura parsing, `generatedAt`).

**Novità tecniche:** gestione update `callback_query`; `allowed_updates: ['message','edited_message','callback_query']` in `scripts/set-webhook.mjs`. Limite messaggi Telegram 4096 caratteri: l'accorpamento per calendario tiene compatta anche Via Pisana (8 tratti, 3 calendari).

### 4. Errori e test

**Errori:** messaggi cortesi per dati assenti/via non trovata/errori Telegram; log su `console.error`; nessun retry (pattern invariato: 200 immediato + `ctx.waitUntil`). La difesa contro dati malformati sta in build, il Worker si fida dello schema del blob.

**Test:** runner nativo Node (`node --test`), zero dipendenze. `npm test` = `node --test test/`.

- `test/schedule.test.mjs` — estrazione campi da description reali; `nextWindow`: giorno/settimana/parità, finestra in corso alle 02:00, cavallo di fine mese, DST (ultime domeniche di marzo/ottobre), query 23:30 UTC = 01:30 Roma.
- `test/search.test.mjs` — esatto/prefisso/sottostringa/fuzzy/zero risultati.
- `test/worker.test.mjs` — e2e simulati: posizione → dettaglio; testo → via unica; testo ambiguo → bottoni → `callback_query`; `/start`; secret errato → 403.

## Rischi e verifiche previste

1. **Parità pari/dispari — ESITO VERIFICA (Task 8, 2026-07-21)**: verificata con il lookup ufficiale del servizio pulizia strade Alia (`https://www2.aliaserviziambientali.it/puliziastrade/` — form "cerca via" e "cerca per data", via gli endpoint AJAX `main/get_indirizzi`, `main/get_tratti`, `pulizie/calcola_data`, `pulizie/calcola_data_all` che alimentano quella pagina), su **4 tratti** con `parity` non nullo, weekday diversi e valori di flag diversi (2 `pari`, 2 `dispari`): BORGO ALLEGRI · DA AGNOLO A PIETRAPIANA (giovedì, pari), BORGO PINTI · DA MATTEOTTI A ALFANI (venerdì, dispari), BORGO OGNISSANTI (sabato, pari), LUNGARNO AMERIGO VESPUCCI · DA VENETO A CURTATONE (domenica, dispari). Per ciascuno sono state confrontate ~14 date settimanali consecutive (23/7–25/10/2026, 56 punti totali) con l'elenco reale delle vie interessate in quella data.
   **Risultato: nessuna delle due ipotesi previste dal piano è confermata.**
   - L'ipotesi codificata (`isoWeek(day) % 2 === 0` per `parity === 'even'`) sbaglia la prossima finestra per tutti e 3 i tratti testati inizialmente (es. Borgo Allegri: previsto 23/7/2026, reale 30/7/2026 secondo Alia).
   - L'ipotesi alternativa "settimane del mese" (`Math.ceil(day.d / 7) % 2 === 0`) sbaglia **anch'essa** la prossima finestra per tutti i tratti testati, e nel complesso si adatta ai 56 punti anche **peggio** dell'ipotesi ISO (punteggio aggregato: 15/56 contro 23/56) — applicarla come fix avrebbe peggiorato la precisione media, non migliorata.
   - I dati reali mostrano un'alternanza settimanale pulita e coerente con la settimana ISO (non con la settimana del mese) da metà settembre in poi, con un'anomalia concentrata nelle settimane di fine luglio/agosto — verosimilmente un aggiustamento stagionale del calendario Alia non documentato pubblicamente (prassi diffusa nei comuni italiani nel periodo estivo). Soprattutto, i 4 tratti testati (2 `pari`, 2 `dispari`) risultano **sincronizzati sulla stessa settimana ISO** invece di alternarsi in modo complementare come l'intuizione sul flag `pari`/`dispari` farebbe supporre: campione insufficiente (4 vie su 290 con `parity`) per trarre una regola generale certa, ma sufficiente per escludere con sicurezza le due ipotesi semplici previste dal piano.
   - **Decisione: nessuna modifica al codice.** Nessuna delle due ipotesi è "vincente" in modo netto e il fallback previsto dal piano peggiora la resa media sul campione testato; `schedule-core.js` resta invariato. Mitigazione permanente (confermata necessaria): il testo `raw` ufficiale è sempre visibile nel dettaglio tratto e ovunque campeggia "fa fede il cartello in strada". Sui ~290 record (16% del dataset) con `parity` non nullo, la "prossima finestra" calcolata può quindi risultare sfasata anche di una settimana rispetto alla realtà: rischio noto e non chiuso da questo task, che richiederebbe di osservare il lookup Alia più a lungo (mesi) o di ottenere documentazione esplicita dell'algoritmo per essere risolto con certezza.
2. **Deriva formato upstream**: coperta dalla validazione in build (fail < 90% parsing) e dalla statistica di copertura in `/info`.
3. **Dimensione blob** (~3,2 MB, in calo con la pulizia di `raw`): ampiamente dentro i limiti KV (25 MB/valore) e isolate (128 MB).

## Fuori scope

- Altri comuni serviti da Alia; numeri civici (il dataset ragiona per tratti, non per civici); geocoding esterno; notifiche push/promemoria ("avvisami la sera prima") — possibile evoluzione futura; GitHub Action di refresh dati (esiste già come idea nel README, non cambia con questo design).

## Dopo l'implementazione

Aggiornare: `README.md` (nuove funzioni), `CLAUDE.md` (architettura), quindi code review e scelta della modalità di pubblicazione (fasi successive già concordate).

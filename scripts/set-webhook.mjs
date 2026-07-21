// Registra (o rimuove) il webhook Telegram verso il tuo Worker.
//
// Uso:
//   BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://tuo-worker.workers.dev \
//     node scripts/set-webhook.mjs
//
//   ...aggiungi  delete  come argomento per rimuovere il webhook:
//   BOT_TOKEN=... node scripts/set-webhook.mjs delete

const token = process.env.BOT_TOKEN;
const url = process.env.WORKER_URL;
const secret = process.env.WEBHOOK_SECRET || '';
const del = process.argv.includes('delete');

if (!token) {
  console.error('❌ BOT_TOKEN mancante.');
  process.exit(1);
}

async function call(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function main() {
  if (del) {
    console.log(await call('deleteWebhook', { drop_pending_updates: true }));
    return;
  }
  if (!url) {
    console.error('❌ WORKER_URL mancante (es. https://tuo-worker.tuo-subdominio.workers.dev).');
    process.exit(1);
  }
  const payload = {
    url,
    allowed_updates: ['message', 'edited_message'],
    drop_pending_updates: true,
  };
  if (secret) payload.secret_token = secret;
  const r = await call('setWebhook', payload);
  console.log('setWebhook:', r);
  console.log('\nStato attuale:');
  console.log(await call('getWebhookInfo', {}));
}

main();

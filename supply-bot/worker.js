// Cloudflare Worker: ретранслятор Telegram -> Apps Script.
// Переменные окружения (Settings -> Variables and Secrets, тип Secret):
//   TG_SECRET        = то же, что SUPPLY_WEBHOOK_SECRET в Script Properties
//   APPS_SCRIPT_URL  = URL веб-приложения Apps Script (оканчивается на /exec)
//   RELAY_SECRET     = то же, что SUPPLY_RELAY_SECRET в Script Properties

const MAX_BODY_BYTES = 1024 * 1024;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function forward(env, body) {
  try {
    const target = new URL(env.APPS_SCRIPT_URL);
    target.searchParams.set('key', env.RELAY_SECRET);
    const resp = await fetch(target.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      redirect: 'follow'
    });
    if (!resp.ok) console.error('apps script responded ' + resp.status);
  } catch (e) {
    console.error('forward failed: ' + (e && e.message));
  }
}

export default {
  async fetch(request, env, ctx) {
    if (!env.TG_SECRET || !env.APPS_SCRIPT_URL || !env.RELAY_SECRET) {
      return new Response('misconfigured', { status: 500 });
    }

    const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!safeEqual(got, env.TG_SECRET)) {
      return new Response('forbidden', { status: 403 });
    }
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }

    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) {
      return new Response('too large', { status: 413 });
    }

    // Telegram получает 200 сразу, пересылка идёт в фоне.
    ctx.waitUntil(forward(env, body));
    return new Response('ok', { status: 200 });
  }
};

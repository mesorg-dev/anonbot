// Анонимки: Telegram-бот анонимных сообщений на Cloudflare Workers + D1.
// Люди пишут боту, ты видишь только придуманное имя (например "Тихий лис"),
// отвечаешь реплаем в чате или в Mini App. Настоящий id человека знает только сервер.

const enc = new TextEncoder();
const DAY = 86400000;
const KEEP_ANSWERED = 7 * DAY; // отвеченные удаляются через 7 дней
const KEEP_ANY = 30 * DAY; // любые сообщения удаляются через 30 дней
const FLOOD_LIMIT = 5; // максимум сообщений в минуту от одного человека

const ADJ = [
  "Тихий", "Смелый", "Хитрый", "Сонный", "Добрый", "Дерзкий", "Робкий", "Весёлый",
  "Мудрый", "Колючий", "Забавный", "Ночной", "Звёздный", "Мягкий", "Грозный", "Шустрый",
];
const ANI = [
  "лис", "ёж", "сыч", "кот", "барсук", "ворон", "енот", "тюлень", "волк",
  "заяц", "жук", "краб", "пингвин", "лось", "хорёк", "бобр", "кабан", "сокол",
];

// ---------- утилиты ----------

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(key, data) {
  const k = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

const say = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, ...extra });

let botName = null;
async function getBotName(env) {
  if (botName === null) {
    const r = await tg(env, "getMe", {});
    botName = r.result?.username || "";
  }
  return botName;
}

// Стабильное придуманное имя для человека: одно и то же при каждом сообщении,
// но по нему нельзя вычислить настоящий id (нужен секрет SECRET).
async function alias(env, uid) {
  const h = await hmac(env.SECRET, "alias:" + uid);
  return {
    name: `${ADJ[h[0] % ADJ.length]} ${ANI[h[1] % ANI.length]}`,
    hue: (h[2] * 256 + h[3]) % 360,
  };
}

function kindOf(m) {
  if (m.text) return null;
  if (m.photo) return "Фото";
  if (m.video) return "Видео";
  if (m.voice) return "Голосовое";
  if (m.video_note) return "Кружок";
  if (m.audio) return "Аудио";
  if (m.document) return "Файл";
  if (m.sticker) return "Стикер";
  if (m.animation) return "GIF";
  return "Вложение";
}

// Проверка подписи initData из Mini App: пускаем только владельца бота.
async function isOwner(req, env) {
  const raw = (req.headers.get("Authorization") || "").replace(/^tma /, "");
  if (!raw) return false;
  const p = new URLSearchParams(raw);
  const hash = p.get("hash");
  if (!hash) return false;
  p.delete("hash");
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac("WebAppData", env.BOT_TOKEN);
  if (hex(await hmac(secret, check)) !== hash) return false;
  if (Date.now() / 1000 - Number(p.get("auth_date")) > DAY / 1000) return false;
  try {
    return String(JSON.parse(p.get("user") || "{}").id) === String(env.OWNER_ID);
  } catch {
    return false;
  }
}

// ---------- логика ----------

function replyHtml(row, text) {
  const orig = (row.text || (row.kind ? `[${row.kind}]` : "")).slice(0, 200);
  const quote = orig ? `<blockquote>${esc(orig)}</blockquote>\n` : "";
  return `${quote}${esc(text)}`;
}

const deliver = (env, row, text) =>
  tg(env, "sendMessage", { chat_id: row.uid, parse_mode: "HTML", text: replyHtml(row, text) });

const markAnswered = (env, id, text) =>
  env.DB.prepare("UPDATE messages SET status='answered', reply_text=?, answered_at=? WHERE id=?")
    .bind(text, Date.now(), id)
    .run();

const banRow = (env, row) =>
  env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO banned (uid, alias, hue, ts) VALUES (?,?,?,?)").bind(
      row.uid, row.alias, row.hue, Date.now(),
    ),
    env.DB.prepare("DELETE FROM messages WHERE uid=?").bind(row.uid),
  ]);

async function cleanup(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE status='answered' AND answered_at<?").bind(now - KEEP_ANSWERED),
    env.DB.prepare("DELETE FROM messages WHERE created_at<?").bind(now - KEEP_ANY),
  ]);
}

async function fromStranger(m, env, origin) {
  const uid = m.chat.id;
  if (m.text === "/start") {
    return say(env, uid, "Напиши сообщение, оно уйдёт анонимно. Ответ придёт сюда, в этот чат.");
  }
  if (await env.DB.prepare("SELECT 1 FROM banned WHERE uid=?").bind(uid).first()) return;

  const flood = await env.DB.prepare("SELECT COUNT(*) AS c FROM messages WHERE uid=? AND created_at>?")
    .bind(uid, Date.now() - 60000)
    .first();
  if (flood.c >= FLOOD_LIMIT) return say(env, uid, "Слишком часто. Подожди минуту.");

  const text = (m.text || m.caption || "").slice(0, 3500);
  const kind = kindOf(m);
  const a = await alias(env, uid);
  const ins = await env.DB.prepare(
    "INSERT INTO messages (uid, alias, hue, text, kind, created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(uid, a.name, a.hue, text, kind, Date.now())
    .run();
  const id = ins.meta.last_row_id;

  const head =
    `<b>${esc(a.name)}</b>  #${id}` +
    (kind ? ` · ${esc(kind)}` : "") +
    (text ? `\n\n${esc(text)}` : "");
  const r = await tg(env, "sendMessage", {
    chat_id: env.OWNER_ID,
    parse_mode: "HTML",
    text: head,
    reply_markup: { inline_keyboard: [[{ text: "Ответить в приложении", web_app: { url: origin } }]] },
  });
  const notif = r.result?.message_id;
  if (notif) {
    await env.DB.prepare("UPDATE messages SET notif_id=? WHERE id=?").bind(notif, id).run();
    // вложение пересылаем отдельно, реплаем на заголовок
    if (kind) {
      await tg(env, "copyMessage", {
        chat_id: env.OWNER_ID,
        from_chat_id: uid,
        message_id: m.message_id,
        reply_parameters: { message_id: notif },
      });
    }
  }
  return say(env, uid, "Отправлено анонимно. Ответ придёт сюда.");
}

async function fromOwner(m, env, origin) {
  const text = m.text || "";
  const owner = env.OWNER_ID;
  if (text === "/start" || text === "/app") {
    return say(env, owner, "Входящие в приложении. Ещё можно просто ответить реплаем на сообщение.", {
      reply_markup: { inline_keyboard: [[{ text: "Открыть входящие", web_app: { url: origin } }]] },
    });
  }
  const rm = m.reply_to_message;
  if (!rm) return;

  let row = null;
  for (const id of [rm.message_id, rm.reply_to_message?.message_id].filter(Boolean)) {
    row = await env.DB.prepare("SELECT * FROM messages WHERE notif_id=?").bind(id).first();
    if (row) break;
  }
  if (!row) return say(env, owner, "Не нашёл, кому отвечать: сообщение старое или уже удалено.");

  if (text.trim() === "/ban") {
    await banRow(env, row);
    return say(env, owner, `Забанен: ${row.alias}`);
  }

  const r = m.text
    ? await deliver(env, row, text)
    : await tg(env, "copyMessage", { chat_id: row.uid, from_chat_id: m.chat.id, message_id: m.message_id });
  if (!r.ok) return say(env, owner, "Не доставлено: " + (r.description || "неизвестная ошибка"));
  await markAnswered(env, row.id, text || "[вложение]");
}

async function onUpdate(u, env, origin) {
  const m = u.message;
  if (!m || m.chat.type !== "private") return;
  return String(m.chat.id) === String(env.OWNER_ID)
    ? fromOwner(m, env, origin)
    : fromStranger(m, env, origin);
}

// ---------- API для Mini App ----------

async function api(req, env, url) {
  if (!(await isOwner(req, env))) return json({ error: "unauthorized" }, 401);
  const p = url.pathname;

  if (p === "/api/state") {
    const [inbox, answered, banned, bot] = await Promise.all([
      env.DB.prepare(
        "SELECT id, alias, hue, text, kind, created_at FROM messages WHERE status='new' ORDER BY created_at DESC LIMIT 200",
      ).all(),
      env.DB.prepare(
        "SELECT id, alias, hue, text, kind, created_at, reply_text, answered_at FROM messages WHERE status='answered' ORDER BY answered_at DESC LIMIT 100",
      ).all(),
      env.DB.prepare("SELECT id, alias, hue, ts FROM banned ORDER BY ts DESC").all(),
      getBotName(env),
    ]);
    return json({ inbox: inbox.results, answered: answered.results, banned: banned.results, bot });
  }

  if (req.method !== "POST") return json({ error: "method" }, 405);
  const b = await req.json().catch(() => ({}));
  const row = b.id
    ? await env.DB.prepare("SELECT * FROM messages WHERE id=?").bind(b.id).first()
    : null;

  switch (p) {
    case "/api/reply": {
      const text = String(b.text || "").trim().slice(0, 3500);
      if (!row) return json({ error: "Сообщение не найдено" }, 404);
      if (!text) return json({ error: "Пустой ответ" }, 400);
      const r = await deliver(env, row, text);
      if (!r.ok) {
        const blocked = /blocked|deactivated|chat not found/i.test(r.description || "");
        return json({ error: "send_failed", detail: blocked ? "Человек заблокировал бота" : r.description }, 502);
      }
      await markAnswered(env, row.id, text);
      return json({ ok: true });
    }
    case "/api/delete":
      if (b.id) await env.DB.prepare("DELETE FROM messages WHERE id=?").bind(b.id).run();
      return json({ ok: true });
    case "/api/ban":
      if (!row) return json({ error: "Сообщение не найдено" }, 404);
      await banRow(env, row);
      return json({ ok: true });
    case "/api/unban":
      if (b.id) await env.DB.prepare("DELETE FROM banned WHERE id=?").bind(b.id).run();
      return json({ ok: true });
    case "/api/clear":
      await env.DB.prepare("DELETE FROM messages WHERE status='answered'").run();
      return json({ ok: true });
    default:
      return json({ error: "not_found" }, 404);
  }
}

// ---------- точка входа ----------

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/webhook" && req.method === "POST") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await req.json();
      ctx.waitUntil(onUpdate(update, env, url.origin).catch((e) => console.error(e)));
      return new Response("ok");
    }

    // Открой в браузере один раз: https://<воркер>.workers.dev/setup?key=<SECRET>
    if (p === "/setup") {
      if (url.searchParams.get("key") !== env.SECRET) return new Response("forbidden", { status: 403 });
      const webhook = await tg(env, "setWebhook", {
        url: url.origin + "/webhook",
        secret_token: env.SECRET,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      });
      const menu = await tg(env, "setChatMenuButton", {
        chat_id: env.OWNER_ID,
        menu_button: { type: "web_app", text: "Входящие", web_app: { url: url.origin } },
      });
      return json({ webhook, menu });
    }

    if (p.startsWith("/api/")) return api(req, env, url);

    return env.ASSETS.fetch(req);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};

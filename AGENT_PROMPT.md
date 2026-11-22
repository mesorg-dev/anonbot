# Задача для агента: развернуть «Анонимки»

Это готовый проект: Telegram-бот анонимных сообщений на Cloudflare Workers + D1 с Mini App (папка `public`). Код менять не нужно, только развернуть. Подробности в `README.md`.

## Сделай

1. Создай приватный репозиторий `anonbot` на GitHub и запушь в него все файлы проекта так, чтобы `wrangler.toml` лежал в корне. `.gitignore` уже есть.
2. Если у тебя есть доступ к Cloudflare (wrangler или API-токен):
   - создай базу D1 с именем `anonbot`: `npx wrangler d1 create anonbot`;
   - впиши полученный `database_id` в `wrangler.toml` вместо `ВСТАВЬ-ID-БАЗЫ` и закоммить;
   - примени схему: `npx wrangler d1 execute anonbot --remote --file=schema.sql`;
   - задеплой: `npx wrangler deploy`;
   - задай секреты командами `npx wrangler secret put <ИМЯ>`: `BOT_TOKEN`, `OWNER_ID`, `SECRET`;
   - открой `https://anonbot.<поддомен>.workers.dev/setup?key=<SECRET>` и убедись, что в ответе `"ok":true` у `webhook` и `menu`.
3. Если доступа к Cloudflare нет, остановись после шага 1 и выдай пользователю список оставшихся шагов из `README.md`.

## Что спросить у пользователя

- `BOT_TOKEN`: токен бота из @BotFather.
- `OWNER_ID`: его числовой Telegram id.
- `SECRET` придумай сам: 32 случайных символа, только буквы и цифры. Покажи его пользователю, он нужен для ссылки `/setup`.

## Правила

- Не коммить токен и `SECRET` в репозиторий, не печатай их в логах и в публичных местах.
- Не меняй логику в `src/index.js` и `public/index.html` без запроса пользователя.
- Имя воркера в `wrangler.toml` (`anonbot`) должно совпадать с именем воркера в Cloudflare.
- В конце коротко отчитайся: ссылка на репозиторий, адрес воркера, прошёл ли `/setup`, что осталось сделать пользователю.

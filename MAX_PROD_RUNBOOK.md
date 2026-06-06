# Боевой запуск MAX-агента

Эта инструкция для Windows/PowerShell. Она поднимает рабочий контур:

- `agent-api` на `http://localhost:3002`
- `max-adapter` на `http://localhost:3001`
- `n8n` в Docker на `http://localhost:5678`
- MAX watcher в режиме всех чатов
- watcher напоминаний

## 1. Перед первым запуском

Проверь `.env` в корне проекта:

```env
DATABASE_URL=postgresql://...
GROQ_API_KEY=...
N8N_WEBHOOK_URL=http://localhost:5678/webhook/incoming-message
AGENT_API_URL=http://localhost:3002
MAX_ADAPTER_PORT=3001
AGENT_API_PORT=3002
MAX_OPEN_BROWSER=true
MAX_HEADLESS=false
```

Проверь зависимости:

```powershell
npm install
cd max-adapter
npm install
cd ..
```

Проверь Docker-контейнер n8n:

```powershell
docker ps
```

Ожидаемо должен быть контейнер с именем `n8n`. Если имя другое, передай его в запусковый скрипт через `-N8nContainer`.

## 2. Важная настройка n8n в Docker

MAX adapter отправляет входящие сообщения в n8n:

```text
http://localhost:5678/webhook/incoming-message
```

Но сам n8n работает внутри Docker. Поэтому, если workflow в n8n вызывает Agent API, в HTTP Request node используй:

```text
http://host.docker.internal:3002/incoming-message
```

Не используй внутри Docker:

```text
http://localhost:3002/incoming-message
```

Внутри контейнера `localhost` означает сам контейнер n8n, а не Windows-хост.

Workflow `incoming_message` должен быть активирован, иначе production webhook вернет `404`.

## 3. Запуск боевого режима

Из корня проекта:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\start-max-prod.ps1
```

Если контейнер n8n называется не `n8n`:

```powershell
.\start-max-prod.ps1 -N8nContainer "my-n8n"
```

Если Chromium/Playwright падает из-за кириллицы в пути проекта, запускай MAX с ASCII-профилем:

```powershell
.\start-max-prod.ps1 `
  -MaxProfileDir "C:\Users\Getsu\max-profile-ai-dental-agent" `
  -MaxArtifactsDir "C:\Users\Getsu\max-artifacts-ai-dental-agent"
```

При первом запуске с новым профилем нужно один раз войти в MAX по QR. После входа профиль сохранится.

## 4. Что делает скрипт

`start-max-prod.ps1`:

1. Стартует Docker-контейнер `n8n`, если он есть.
2. Убивает старые процессы на портах `3001` и `3002`.
3. Запускает `agent-api`.
4. Запускает `max-adapter`.
5. Открывает MAX Web.
6. Включает MAX watcher:

```json
{
  "interval_ms": 5000,
  "mode": "all",
  "worker_interval_ms": 1500
}
```

7. Включает watcher напоминаний:

```json
{
  "interval_ms": 60000
}
```

8. Печатает итоговый статус.

## 5. Проверка после запуска

Health:

```powershell
Invoke-RestMethod http://localhost:3002/health
Invoke-RestMethod http://localhost:3001/health
Invoke-RestMethod http://localhost:5678/healthz
```

MAX watcher:

```powershell
Invoke-RestMethod http://localhost:3001/max/watch/status
```

Нормально:

```text
running: true
last_error: null
last_scan_result.chats_seen > 0
```

Очередь:

```powershell
Invoke-RestMethod http://localhost:3001/max/queue/status
```

Напоминания:

```powershell
Invoke-RestMethod http://localhost:3001/reminders/watch/status
```

Админка Agent API:

```text
http://localhost:3002/admin
```

## 6. Логи

Скрипт пишет логи сюда:

```text
logs/agent-api.prod.out.log
logs/agent-api.prod.err.log
logs/max-adapter.prod.out.log
logs/max-adapter.prod.err.log
```

Быстро посмотреть хвост:

```powershell
Get-Content -Tail 80 logs\agent-api.prod.err.log
Get-Content -Tail 80 logs\max-adapter.prod.err.log
```

## 7. Типовые проблемы

### MAX watcher `running: true`, но `chats_seen: 0`

Причины:

- MAX открыт на QR-login.
- Слетел web-login.
- Селекторы MAX изменились.

Проверка:

```powershell
Invoke-RestMethod -Method Post http://localhost:3001/max/inspect
```

Если в `selector_counts` все нули и на screenshot QR, войди в MAX по QR.

### Ошибка `Target page, context or browser has been closed`

Это зависший Playwright/Chromium контекст. Решение:

```powershell
.\start-max-prod.ps1
```

Если повторяется из-за пути с кириллицей, запускай с ASCII-профилем:

```powershell
.\start-max-prod.ps1 `
  -MaxProfileDir "C:\Users\Getsu\max-profile-ai-dental-agent" `
  -MaxArtifactsDir "C:\Users\Getsu\max-artifacts-ai-dental-agent"
```

### n8n webhook возвращает `404`

Проверь, что workflow `incoming_message` активен. Production webhook работает только у активного workflow.

### n8n не может достучаться до Agent API

В n8n Docker используй:

```text
http://host.docker.internal:3002/incoming-message
```

### MAX отправляет не тот ответ или старый ответ

Проверь:

```powershell
Invoke-RestMethod http://localhost:3001/max/queue/status
Get-Content -Tail 120 logs\max-adapter.prod.out.log
Get-Content -Tail 120 logs\agent-api.prod.out.log
```

## 8. Ручной перезапуск только MAX watcher

```powershell
Invoke-RestMethod -Method Post http://localhost:3001/max/watch/stop
Invoke-RestMethod `
  -Uri http://localhost:3001/max/watch/start `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"interval_ms":5000,"mode":"all","worker_interval_ms":1500}'
```

## 9. Ручной перезапуск только reminder watcher

```powershell
Invoke-RestMethod -Method Post http://localhost:3001/reminders/watch/stop
Invoke-RestMethod `
  -Uri http://localhost:3001/reminders/watch/start `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"interval_ms":60000}'
```

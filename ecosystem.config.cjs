// PM2 process manager config for the AI Dental Agent stack.
//
// Запуск (из корня проекта):
//   npm i -g pm2
//   pm2 start ecosystem.config.cjs
//   pm2 save                 # запомнить текущий набор процессов
//   pm2 startup              # включить автозапуск при загрузке ОС (выполнить выведенную команду)
//
// Полезное:
//   pm2 ls            — список процессов и статус
//   pm2 logs          — живые логи обоих сервисов
//   pm2 restart all   — перезапустить всё (после git pull / правок кода)
//   pm2 stop all      — остановить (например, перед `prisma generate`)
//
// ВАЖНО про prisma generate: max-adapter грузит корневой движок Prisma,
// поэтому перед генерацией клиента остановите ОБА процесса: `pm2 stop all`.
//
// Linux VPS + браузер MAX: max-adapter поднимает headful-браузер. На сервере
// без дисплея запускайте под Xvfb — например, замените в app `max-adapter`
// поле script на "xvfb-run" и interpreter на "none" (см. закомментированный вариант),
// либо стартуйте pm2 из-под `xvfb-run -a pm2 ...`.

module.exports = {
  apps: [
    {
      name: "agent-api",
      script: "agent-api/src/index.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      time: true,
      out_file: "logs/pm2-agent-api.out.log",
      error_file: "logs/pm2-agent-api.err.log",
      env: {
        AGENT_API_PORT: "3002"
      }
    },
    {
      name: "max-adapter",
      script: "max-adapter/src/index.js",
      // На Linux без дисплея вместо двух строк выше используйте:
      //   script: "xvfb-run",
      //   args: "-a node max-adapter/src/index.js",
      //   interpreter: "none",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      time: true,
      out_file: "logs/pm2-max-adapter.out.log",
      error_file: "logs/pm2-max-adapter.err.log",
      env: {
        MAX_ADAPTER_PORT: "3001",
        MAX_OPEN_BROWSER: "false",
        MAX_HEADLESS: "false",
        AGENT_API_URL: "http://localhost:3002",
        N8N_WEBHOOK_URL: "http://localhost:5678/webhook/incoming-message"
      }
    }
  ]
};

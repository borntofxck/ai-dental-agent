import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(process.cwd());
const baseDir = path.resolve(repoRoot, '..');
const assetsDir = path.join(baseDir, 'docs', 'diploma_assets');
const require = createRequire(path.join(repoRoot, 'max-adapter', 'package.json'));
const { chromium } = require('playwright');

const baseStyle = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f5f7fb;
    font-family: "Segoe UI", Arial, sans-serif;
    color: #111827;
  }
  .canvas {
    width: 1280px;
    min-height: 720px;
    padding: 42px;
    background: #f5f7fb;
  }
  h1 {
    font-size: 30px;
    margin: 0 0 26px;
    line-height: 1.2;
    color: #111827;
  }
  .muted { color: #475569; }
  .row { display: flex; gap: 18px; align-items: stretch; }
  .box {
    background: #fff;
    border: 1px solid #d8dee9;
    border-radius: 12px;
    padding: 20px;
    box-shadow: 0 10px 28px rgba(15, 23, 42, .08);
  }
  .arrow {
    font-size: 34px;
    color: #2563eb;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
  }
  .tag {
    display: inline-block;
    padding: 5px 10px;
    border-radius: 999px;
    background: #e0f2fe;
    color: #075985;
    font-size: 13px;
    margin-bottom: 10px;
    font-weight: 700;
  }
  .grid { display: grid; gap: 14px; }
  .small { font-size: 15px; line-height: 1.45; }
  .title { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
  .table {
    display: grid;
    grid-template-columns: 120px 1fr 1fr;
    gap: 1px;
    background: #cbd5e1;
    border: 1px solid #cbd5e1;
  }
  .cell {
    background: #fff;
    padding: 14px;
    font-size: 15px;
    line-height: 1.35;
  }
  .head { background: #e2e8f0; font-weight: 700; }
  .accent { border-left: 5px solid #2563eb; }
  .green { border-left-color: #16a34a; }
  .orange { border-left-color: #f97316; }
  .red { border-left-color: #dc2626; }
`;

function pageHtml(body) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <style>${baseStyle}</style>
</head>
<body>
  <div class="canvas">${body}</div>
</body>
</html>`;
}

const diagrams = [
  {
    name: 'diagram_architecture',
    html: pageHtml(`
      <h1>Архитектура MVP AI-агента стоматологической клиники</h1>
      <div class="row">
        <div class="box accent" style="width:170px">
          <div class="tag">Канал</div>
          <div class="title">MAX</div>
          <div class="small muted">Web-интерфейс пациента, входящие сообщения и ответы</div>
        </div>
        <div class="arrow">→</div>
        <div class="box green" style="width:210px">
          <div class="tag">Адаптер</div>
          <div class="title">Node.js + Playwright</div>
          <div class="small muted">Читает новые сообщения, открывает чаты, отправляет ответы</div>
        </div>
        <div class="arrow">→</div>
        <div class="box orange" style="width:160px">
          <div class="tag">Workflow</div>
          <div class="title">n8n</div>
          <div class="small muted">Webhook, маршрутизация, контроль шагов</div>
        </div>
        <div class="arrow">→</div>
        <div class="box accent" style="width:210px">
          <div class="tag">Логика</div>
          <div class="title">Agent API</div>
          <div class="small muted">Память диалога, AI-ответ, запись, напоминания</div>
        </div>
        <div class="arrow">→</div>
        <div class="box red" style="width:170px">
          <div class="tag">Данные</div>
          <div class="title">PostgreSQL</div>
          <div class="small muted">Контакты, переписки, заявки, слоты, врачи</div>
        </div>
      </div>
      <div class="box" style="margin-top:32px">
        <div class="title">Основная идея архитектуры</div>
        <div class="small">
          Браузерный адаптер работает с MAX, n8n управляет маршрутом обработки,
          Agent API принимает решение и сохраняет результат в PostgreSQL. Такой подход подходит для MVP
          и оставляет возможность дальнейшего развития.
        </div>
      </div>
    `),
  },
  {
    name: 'diagram_sequence',
    html: pageHtml(`
      <h1>Сценарий обработки входящего сообщения</h1>
      <div class="table">
        <div class="cell head">Шаг</div>
        <div class="cell head">Действие системы</div>
        <div class="cell head">Результат</div>
        <div class="cell">1</div>
        <div class="cell">MAX-адаптер находит новое сообщение в списке чатов</div>
        <div class="cell">Формируется структурированный JSON payload</div>
        <div class="cell">2</div>
        <div class="cell">n8n принимает webhook и передает данные в Agent API</div>
        <div class="cell">Запускается единый сценарий обработки</div>
        <div class="cell">3</div>
        <div class="cell">Agent API находит контакт и активный диалог</div>
        <div class="cell">История клиента не теряется</div>
        <div class="cell">4</div>
        <div class="cell">В PostgreSQL сохраняются входящее сообщение и состояние памяти</div>
        <div class="cell">AI получает контекст обращения</div>
        <div class="cell">5</div>
        <div class="cell">AI формирует безопасный ответ, уточняет жалобу, дату и время</div>
        <div class="cell">Пациент получает понятный следующий шаг</div>
        <div class="cell">6</div>
        <div class="cell">При согласии создаются appointment_request и appointment_slot</div>
        <div class="cell">Двойная запись на одно время блокируется</div>
        <div class="cell">7</div>
        <div class="cell">Создаются appointment_reminders</div>
        <div class="cell">Система готовит напоминание перед визитом</div>
        <div class="cell">8</div>
        <div class="cell">Ответ возвращается через n8n и MAX-адаптер</div>
        <div class="cell">Пациент видит сообщение в MAX</div>
      </div>
    `),
  },
  {
    name: 'diagram_database',
    html: pageHtml(`
      <h1>Логическая структура базы данных</h1>
      <div class="grid" style="grid-template-columns: repeat(4, 1fr)">
        <div class="box"><div class="tag">Клиент</div><div class="title">contacts</div><div class="small">Пациент и MAX ID</div><div class="small muted" style="margin-top:8px">conversations, messages, appointments</div></div>
        <div class="box"><div class="tag">Диалог</div><div class="title">conversations</div><div class="small">Активная переписка</div><div class="small muted" style="margin-top:8px">messages, memory, actions</div></div>
        <div class="box"><div class="tag">История</div><div class="title">messages</div><div class="small">Входящие и исходящие сообщения</div><div class="small muted" style="margin-top:8px">incoming / outgoing</div></div>
        <div class="box"><div class="tag">Память</div><div class="title">conversation_memory</div><div class="small">Контекст диалога</div><div class="small muted" style="margin-top:8px">intent, complaint, time</div></div>
        <div class="box"><div class="tag">Запись</div><div class="title">appointment_requests</div><div class="small">Заявка на прием</div><div class="small muted" style="margin-top:8px">имя, жалоба, дата, врач</div></div>
        <div class="box"><div class="tag">Слот</div><div class="title">appointment_slots</div><div class="small">Занятое время</div><div class="small muted" style="margin-top:8px">unique date + time</div></div>
        <div class="box"><div class="tag">Сервис</div><div class="title">appointment_reminders</div><div class="small">Напоминания</div><div class="small muted" style="margin-top:8px">за 24 часа и за 2 часа</div></div>
        <div class="box"><div class="tag">Логи</div><div class="title">agent_actions</div><div class="small">Шаги агента</div><div class="small muted" style="margin-top:8px">answer / handoff</div></div>
        <div class="box"><div class="tag">Риск</div><div class="title">handoffs</div><div class="small">Передача человеку</div><div class="small muted" style="margin-top:8px">причина и статус</div></div>
        <div class="box"><div class="tag">Врачи</div><div class="title">doctors</div><div class="small">Список врачей</div><div class="small muted" style="margin-top:8px">ФИО, специализация</div></div>
        <div class="box"><div class="tag">Услуги</div><div class="title">clinic_services</div><div class="small">Услуги и цены</div><div class="small muted" style="margin-top:8px">категория, цена</div></div>
        <div class="box"><div class="tag">CRM</div><div class="title">follow_up_rules</div><div class="small">Повторные касания</div><div class="small muted" style="margin-top:8px">лидогенерация</div></div>
      </div>
    `),
  },
];

function adminHtml(active, content) {
  const menu = ['Дашборд', 'Переписки', 'Заявки', 'Промт и база знаний', 'База данных', 'Тест агента'];
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; color: #0f172a; background: #f3f6fb; }
    header { height: 56px; display: flex; align-items: center; gap: 12px; padding: 0 12px; background: #fff; border-bottom: 1px solid #d8dee9; }
    .brand { font-weight: 800; font-size: 20px; }
    .badge { border: 1px solid #cfd8e3; border-radius: 6px; padding: 3px 7px; font-size: 12px; font-weight: 700; background: #f8fafc; }
    .spacer { flex: 1; }
    button, select { border: 1px solid #cfd8e3; background: #fff; border-radius: 6px; padding: 9px 13px; font-size: 14px; }
    .primary { background: #0d6efd; border-color: #0d6efd; color: #fff; }
    .layout { display: grid; grid-template-columns: 250px 1fr; min-height: calc(100vh - 56px); }
    aside { background: #fff; border-right: 1px solid #d8dee9; padding: 16px; }
    .nav { padding: 13px 12px; margin-bottom: 4px; border-radius: 8px; color: #10213d; font-size: 15px; }
    .nav.active { background: #e7efff; color: #005bff; }
    main { padding: 24px 22px; }
    h1 { margin: 0 0 6px; font-size: 25px; }
    .sub { color: #64748b; margin-bottom: 18px; }
    .cards { display: grid; grid-template-columns: repeat(6, 1fr); gap: 16px; margin-bottom: 20px; }
    .card, .panel { background: #fff; border: 1px solid #d8dee9; border-radius: 8px; overflow: hidden; }
    .card { padding: 18px 16px; }
    .label { color: #64748b; font-size: 14px; }
    .num { font-size: 30px; font-weight: 800; margin-top: 10px; }
    .panel-title { padding: 14px 16px; font-weight: 700; border-bottom: 1px solid #d8dee9; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .report { background: #111827; color: #f8fafc; padding: 18px; height: 220px; font: 13px Consolas, monospace; white-space: pre-line; }
    .item { padding: 12px 16px; border-bottom: 1px solid #d8dee9; }
    .meta { color: #64748b; font-size: 13px; margin-top: 3px; }
    table { border-collapse: collapse; width: 100%; background: #fff; border: 1px solid #d8dee9; border-radius: 8px; overflow: hidden; }
    th, td { border-bottom: 1px solid #d8dee9; text-align: left; padding: 9px 8px; font-size: 14px; vertical-align: top; }
    th { background: #f8fafc; font-weight: 800; }
    .pill { display: inline-block; border-radius: 6px; padding: 3px 7px; font-weight: 700; font-size: 12px; background: #e8f1ff; color: #0d6efd; }
    .pending { background: #ffd43b; color: #111827; }
    .sent { background: #12b886; color: #fff; }
    .bubble { max-width: 68%; padding: 14px; border: 1px solid #d8dee9; border-radius: 8px; margin: 12px 16px; background: #fff; }
    .bubble.out { margin-left: auto; background: #e8f1ff; border-color: #b9d2ff; }
    .memory { background: #111827; color: #f8fafc; padding: 18px; font: 13px Consolas, monospace; min-height: 230px; white-space: pre-line; }
    textarea, input { width: 100%; border: 1px solid #d8dee9; border-radius: 7px; padding: 12px; font: 14px "Segoe UI", Arial, sans-serif; background: #fff; }
    textarea { min-height: 120px; resize: none; }
    .form-grid { display: grid; grid-template-columns: 1fr 1.4fr; gap: 16px; }
  </style>
</head>
<body>
  <header><div class="brand">DentalCare Admin</div><div class="badge">AI admin MVP</div><div class="spacer"></div><button>Обновить</button><button class="primary">Health</button></header>
  <div class="layout">
    <aside>${menu.map((item) => `<div class="nav ${item === active ? 'active' : ''}">${item}</div>`).join('')}</aside>
    <main>${content}</main>
  </div>
</body>
</html>`;
}

const adminScreens = [
  {
    name: 'admin_dashboard',
    html: adminHtml('Дашборд', `
      <h1>Панель управления</h1>
      <div class="sub">Короткая сводка по сообщениям, заявкам и напоминаниям</div>
      <div class="cards">
        <div class="card"><div class="label">Контакты</div><div class="num">18</div><div class="meta">Новых сегодня: 3</div></div>
        <div class="card"><div class="label">Активные диалоги</div><div class="num">9</div><div class="meta">Открытые conversation</div></div>
        <div class="card"><div class="label">Сообщения</div><div class="num">64</div><div class="meta">Сегодня: 12</div></div>
        <div class="card"><div class="label">Заявки</div><div class="num">7</div><div class="meta">Сегодня: 4</div></div>
        <div class="card"><div class="label">Handoff</div><div class="num">1</div><div class="meta">Открытых передач</div></div>
        <div class="card"><div class="label">Напоминания</div><div class="num">8</div><div class="meta">Ожидают отправки</div></div>
      </div>
      <div class="grid2">
        <div class="panel"><div class="panel-title">Отчет для руководителя</div><div class="report">Отчет DentalCare за 20.05.2026
Новых контактов: 3
Сообщений за день: 12
Заявок на прием за день: 4
Подтвержденных записей: 3
Ожидающих напоминаний: 8</div></div>
        <div class="panel"><div class="panel-title">Последние сообщения</div>
          <div class="item"><b>Мария Диплом</b><div class="meta">outgoing / assistant · 20.05.26, 20:25</div>Мария, записала вас на лечение кариеса 10.06.2026 в 14:00. Напоминание перед визитом создано.</div>
          <div class="item"><b>Анна</b><div class="meta">incoming / user · 20.05.26, 19:48</div>Здравствуйте, хочу узнать стоимость профессиональной гигиены.</div>
          <div class="item"><b>Дмитрий</b><div class="meta">outgoing / assistant · 20.05.26, 18:30</div>Дмитрий, ближайшее свободное время у врача завтра после 15:00.</div>
        </div>
      </div>
    `),
  },
  {
    name: 'admin_conversation_clean',
    html: adminHtml('Переписки', `
      <h1>Переписки</h1><div class="sub">История сообщений, память диалога, заявки и handoff</div>
      <div class="grid2">
        <div class="panel">
          <div class="item"><b>Мария Диплом</b><span style="float:right">#20</span><div class="meta">doc_demo_001 · 20.05.26, 20:25</div>Мария, записала вас на лечение кариеса 10.06.2026 в 14:00...</div>
          <div class="item"><b>Анна</b><span style="float:right">#19</span><div class="meta">max_anna_001 · 20.05.26, 19:48</div>Стоимость профессиональной гигиены начинается от 3500 рублей...</div>
          <div class="item"><b>Дмитрий</b><span style="float:right">#18</span><div class="meta">max_dmitry_001 · 20.05.26, 18:30</div>Подскажите, пожалуйста, какой день вам удобнее для приема...</div>
        </div>
        <div class="panel">
          <div class="panel-title">Мария Диплом <span class="pill" style="float:right">active</span><div class="meta">doc_demo_001 · MAX</div></div>
          <div class="bubble">Здравствуйте, хочу узнать стоимость лечения кариеса.<div class="meta">incoming · 20.05.26, 20:22</div></div>
          <div class="bubble out">Здравствуйте, Мария. Стоимость зависит от осмотра и объема лечения. Могу сориентировать по услугам и записать вас на прием.<div class="meta">outgoing · 20.05.26, 20:23</div></div>
          <div class="bubble">Меня зовут Мария, болит зуб, хочу записаться 10 июня в 14:00.<div class="meta">incoming · 20.05.26, 20:24</div></div>
          <div class="bubble out">Мария, готово. Записала вас на 10.06.2026 в 14:00. Напоминание перед визитом создано.<div class="meta">outgoing · 20.05.26, 20:25</div></div>
          <div class="grid2" style="border-top:1px solid #d8dee9">
            <div style="padding:16px"><b>Память диалога</b><div class="memory">{
  "patient_name": "Мария",
  "intent": "book_appointment",
  "complaint": "болит зуб",
  "preferred_date": "2026-06-10",
  "preferred_time": "14:00"
}</div></div>
            <div style="padding:16px"><b>Заявки и handoff</b><div class="card" style="margin-top:10px"><b>Заявка #21</b><span class="pill" style="float:right">confirmed</span><div>Мария · 14:00 · 10.06.2026</div><div class="meta">лечение кариеса</div></div></div>
          </div>
        </div>
      </div>
    `),
  },
  {
    name: 'admin_appointments',
    html: adminHtml('Заявки', `
      <h1>Заявки и напоминания</h1><div class="sub">Записи, статусы, слоты и созданные напоминания</div>
      <table>
        <tr><th>ID</th><th>Пациент</th><th>Жалоба / услуга</th><th>Дата</th><th>Время</th><th>Статус</th><th>Напоминания</th><th></th></tr>
        <tr><td>#21</td><td><b>Мария</b><div class="meta">+79001234567</div></td><td>лечение кариеса</td><td>10.06.2026</td><td>14:00</td><td>confirmed</td><td><span class="pill pending">pending</span> 24h_before<br><span class="pill pending">pending</span> 2h_before</td><td><button>Сохранить</button></td></tr>
        <tr><td>#22</td><td><b>Анна</b><div class="meta">+79007654321</div></td><td>профгигиена</td><td>11.06.2026</td><td>16:30</td><td>confirmed</td><td><span class="pill sent">sent</span> 24h_before</td><td><button>Сохранить</button></td></tr>
        <tr><td>#23</td><td><b>Дмитрий</b><div class="meta">+79005550101</div></td><td>консультация</td><td>12.06.2026</td><td>12:00</td><td>new</td><td>Нет</td><td><button>Сохранить</button></td></tr>
        <tr><td>#24</td><td><b>Екатерина</b><div class="meta">+79009998877</div></td><td>осмотр после лечения</td><td>13.06.2026</td><td>10:00</td><td>confirmed</td><td><span class="pill pending">pending</span> 24h_before</td><td><button>Сохранить</button></td></tr>
      </table>
    `),
  },
  {
    name: 'admin_prompts',
    html: adminHtml('Промт и база знаний', `
      <h1>Промт и база знаний</h1><div class="sub">Здесь можно менять поведение агента, цены и контекст клиники</div>
      <div class="grid2">
        <div class="panel"><div class="panel-title">Системный промт</div><textarea># Dental Clinic AI Admin System Prompt
Ты администратор стоматологической клиники. Отвечай естественно, уточняй жалобу, дату и время, не ставь диагнозы и передавай срочные случаи человеку.</textarea></div>
        <div class="panel"><div class="panel-title">База знаний и цены</div><textarea># База знаний клиники DentalCare
Консультация стоматолога: от 1500 рублей
Лечение кариеса: от 4500 рублей
Профессиональная гигиена: от 3500 рублей</textarea></div>
      </div>
      <button class="primary" style="margin-top:16px">Сохранить</button>
    `),
  },
  {
    name: 'admin_database',
    html: adminHtml('База данных', `
      <h1>Просмотр базы данных</h1><div class="sub">Быстрый просмотр основных таблиц PostgreSQL без Prisma Studio</div>
      <table>
        <tr><th>id</th><th>maxUserId</th><th>displayName</th><th>phone</th><th>createdAt</th><th>updatedAt</th></tr>
        <tr><td>130</td><td>doc_demo_001</td><td>Мария Диплом</td><td>+79001234567</td><td>2026-05-20T15:25:35Z</td><td>2026-05-20T15:25:37Z</td></tr>
        <tr><td>131</td><td>max_anna_001</td><td>Анна</td><td>+79007654321</td><td>2026-05-20T16:10:00Z</td><td>2026-05-20T16:11:12Z</td></tr>
        <tr><td>132</td><td>max_dmitry_001</td><td>Дмитрий</td><td>+79005550101</td><td>2026-05-20T17:05:23Z</td><td>2026-05-20T17:08:44Z</td></tr>
        <tr><td>133</td><td>max_ekaterina_001</td><td>Екатерина</td><td>+79009998877</td><td>2026-05-20T18:41:11Z</td><td>2026-05-20T18:42:20Z</td></tr>
        <tr><td>134</td><td>max_ivan_001</td><td>Иван</td><td>+79002223344</td><td>2026-05-20T19:00:00Z</td><td>2026-05-20T19:03:16Z</td></tr>
      </table>
    `),
  },
  {
    name: 'admin_test_agent',
    html: adminHtml('Тест агента', `
      <div class="form-grid">
        <div class="panel"><div class="panel-title">Тестовое сообщение</div>
          <label>Имя</label><input value="Мария">
          <div style="height:16px"></div>
          <label>Сообщение</label><textarea>Здравствуйте, болит зуб, хочу записаться завтра после 18:00</textarea>
          <button class="primary" style="margin-top:16px">Отправить агенту</button>
        </div>
        <div class="panel"><div class="panel-title">Ответ API</div><div class="memory" style="min-height:220px">{
  "reply": "Мария, понимаю. Подскажите, пожалуйста, удобно завтра в 18:30?",
  "intent": "book_appointment",
  "urgency": "normal",
  "should_handoff": false
}</div></div>
      </div>
    `),
  },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

  for (const diagram of diagrams) {
    const htmlPath = path.join(assetsDir, `${diagram.name}.html`);
    const pngPath = path.join(assetsDir, `${diagram.name}.png`);
    fs.writeFileSync(htmlPath, diagram.html, 'utf8');
    await page.goto(`file://${htmlPath.replace(/\\/g, '/')}`);
    await page.screenshot({ path: pngPath, fullPage: false });
    console.log(`updated ${pngPath}`);
  }

  await page.setViewportSize({ width: 1440, height: 1080 });
  for (const screen of adminScreens) {
    const htmlPath = path.join(assetsDir, `${screen.name}.html`);
    const pngPath = path.join(assetsDir, `${screen.name}.png`);
    fs.writeFileSync(htmlPath, screen.html, 'utf8');
    await page.goto(`file://${htmlPath.replace(/\\/g, '/')}`);
    await page.screenshot({ path: pngPath, fullPage: false });
    console.log(`updated ${pngPath}`);
  }

  await browser.close();
}

main();

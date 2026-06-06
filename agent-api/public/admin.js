const apiBase = "/api/admin";

const state = {
  activePage: "dashboard",
  selectedConversationId: null,
  promptsLoaded: false,
  tablesLoaded: false,
  conversations: { page: 1, pageSize: 30 },
  appointments: { page: 1, pageSize: 30 },
  broadcast: {
    recipientsPage: 1,
    recipientsPageSize: 25,
    outboundPage: 1,
    outboundPageSize: 30,
    recipients: [],
    selected: new Map()
  },
  database: {
    page: 1,
    pageSize: 50,
    rows: [],
    columns: []
  }
};

const pageLoaders = {
  dashboard: loadDashboard,
  conversations: loadConversations,
  appointments: loadAppointments,
  broadcast: loadBroadcast,
  prompts: loadPrompts,
  database: loadTables,
  test: async () => {}
};

function $(selector) {
  return document.querySelector(selector);
}

function $all(selector) {
  return Array.from(document.querySelectorAll(selector));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function shortText(value, length = 120) {
  const text = String(value ?? "").trim();
  if (text.length <= length) return text;
  return `${text.slice(0, length - 1)}…`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("ru-RU");
}

function prettyJson(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

function badge(value) {
  const text = escapeHtml(value || "none");
  const tone = {
    active: "text-bg-success",
    confirmed: "text-bg-success",
    sent: "text-bg-success",
    queued: "text-bg-primary",
    processing: "text-bg-info",
    pending: "text-bg-warning",
    waiting_confirmation: "text-bg-warning",
    new: "text-bg-primary",
    open: "text-bg-danger",
    handoff_required: "text-bg-danger",
    human_takeover: "text-bg-danger",
    needs_admin_review: "text-bg-danger",
    resolved: "text-bg-secondary",
    cancelled: "text-bg-dark",
    failed: "text-bg-danger"
  }[value] || "text-bg-light border";

  return `<span class="badge ${tone}">${text}</span>`;
}

function buildQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  return data;
}

function toast(message) {
  $("#toastBody").textContent = message;
  const toastElement = $("#appToast");
  if (window.bootstrap?.Toast) {
    window.bootstrap.Toast.getOrCreateInstance(toastElement).show();
  }
}

function showError(error) {
  console.error(error);
  toast(error.message || "Ошибка");
}

async function checkHealth() {
  const pill = $("#healthPill");
  try {
    const response = await fetch("/health");
    const data = await response.json();
    pill.textContent = data.database === "connected" ? "online" : "api ok";
    pill.classList.toggle("ok", true);
    pill.classList.toggle("bad", false);
  } catch {
    pill.textContent = "offline";
    pill.classList.toggle("ok", false);
    pill.classList.toggle("bad", true);
  }
}

function setPage(page) {
  state.activePage = page;
  $all(".page-section").forEach((section) => {
    section.classList.toggle("active", section.id === `page-${page}`);
  });
  $all(".side-link").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page);
  });
  pageLoaders[page]?.().catch(showError);
}

function renderPagination(containerSelector, meta, onPageChange) {
  const container = $(containerSelector);
  if (!container) return;
  const page = Number(meta?.page || 1);
  const totalPages = Number(meta?.total_pages || 1);
  const total = Number(meta?.total || 0);
  const pageSize = Number(meta?.page_size || 0);
  container.innerHTML = `
    <div class="muted">Стр. ${page} из ${totalPages} · ${total} записей${pageSize ? ` · по ${pageSize}` : ""}</div>
    <div class="pagination-actions">
      <button class="btn btn-sm btn-outline-secondary" data-page-action="prev" ${page <= 1 ? "disabled" : ""}>Назад</button>
      <button class="btn btn-sm btn-outline-secondary" data-page-action="next" ${page >= totalPages ? "disabled" : ""}>Вперед</button>
    </div>
  `;
  container.querySelector('[data-page-action="prev"]')?.addEventListener("click", () => onPageChange(Math.max(page - 1, 1)));
  container.querySelector('[data-page-action="next"]')?.addEventListener("click", () => onPageChange(Math.min(page + 1, totalPages)));
}

async function loadDashboard() {
  await checkHealth();
  const { stats, report, latestMessages } = await api("/stats");
  const cards = [
    ["Контакты", stats.contacts, `сегодня ${stats.contactsToday}`],
    ["Диалоги", stats.activeConversations, "активные"],
    ["Сообщения", stats.messages, `сегодня ${stats.messagesToday}`],
    ["Заявки", stats.appointments, `сегодня ${stats.appointmentsToday}`],
    ["Handoff", stats.openHandoffs, "открытые"],
    ["Напоминания", stats.pendingReminders, "ожидают"]
  ];

  $("#statsGrid").innerHTML = cards.map(([label, value, hint]) => `
    <div class="stat-card">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(value)}</div>
      <div class="stat-hint">${escapeHtml(hint)}</div>
    </div>
  `).join("");

  $("#todayReport").textContent = report;
  $("#latestMessages").innerHTML = latestMessages.length
    ? latestMessages.map((message) => `
      <button class="list-item" data-open-conversation="${message.conversationId}">
        <div class="d-flex justify-content-between gap-3">
          <strong>${escapeHtml(message.contact?.displayName || message.contact?.maxUserId || `Контакт ${message.contactId}`)}</strong>
          <span class="small-muted">${formatDateTime(message.createdAt)}</span>
        </div>
        <div class="small-muted">${escapeHtml(message.direction)} / ${escapeHtml(message.role)}</div>
        <div>${escapeHtml(shortText(message.text, 150))}</div>
      </button>
    `).join("")
    : `<div class="empty-state">Сообщений пока нет.</div>`;
}

async function loadConversations() {
  state.conversations.pageSize = Number($("#conversationPageSize").value || 30);
  const query = buildQuery({
    search: $("#conversationSearch").value.trim(),
    status: $("#conversationStatusFilter").value,
    page: state.conversations.page,
    page_size: state.conversations.pageSize
  });
  const { conversations, pagination } = await api(`/conversations${query}`);
  $("#conversationCount").textContent = `${pagination.total} всего`;
  $("#conversationList").innerHTML = conversations.length
    ? conversations.map((conversation) => {
        const contact = conversation.contact || {};
        const last = conversation.messages?.[0];
        const active = conversation.id === state.selectedConversationId ? "active" : "";
        return `
          <button class="conversation-item ${active}" data-conversation-id="${conversation.id}">
            <div class="d-flex justify-content-between gap-2">
              <strong>${escapeHtml(contact.displayName || contact.maxUserId || `Контакт ${conversation.contactId}`)}</strong>
              <span class="small-muted">#${conversation.id}</span>
            </div>
            <div class="small-muted">${escapeHtml(contact.maxUserId || "-")} · ${formatDateTime(conversation.lastMessageAt)}</div>
            <div class="mt-1">${escapeHtml(shortText(last?.text || "Нет сообщений", 110))}</div>
            <div class="small-muted mt-1">${conversation._count.messages} сообщ. · ${conversation._count.appointments} заявок · ${conversation._count.handoffs} handoff</div>
          </button>
        `;
      }).join("")
    : `<div class="empty-state">Переписки не найдены.</div>`;
  renderPagination("#conversationPagination", pagination, (page) => {
    state.conversations.page = page;
    loadConversations().catch(showError);
  });
}

async function loadConversation(id) {
  state.selectedConversationId = Number(id);
  await loadConversations();

  const { conversation } = await api(`/conversations/${id}`);
  const contact = conversation.contact || {};
  const messages = conversation.messages || [];
  const appointments = conversation.appointments || [];
  const handoffs = conversation.handoffs || [];

  $("#conversationDetail").innerHTML = `
    <div class="panel-title">
      <div class="d-flex justify-content-between gap-3">
        <div>
          <div class="fw-semibold">${escapeHtml(contact.displayName || contact.maxUserId || `Контакт ${conversation.contactId}`)}</div>
          <div class="small-muted">${escapeHtml(contact.maxUserId || "-")} · ${escapeHtml(conversation.channel || "-")}</div>
        </div>
        <div class="d-flex align-items-start gap-2">
          <button class="btn btn-sm btn-outline-danger" data-reset-conversation-context="${conversation.id}">Сбросить контекст</button>
          ${badge(conversation.status)}
        </div>
      </div>
    </div>
    <div class="messages">
      ${messages.map((message) => `
        <div class="message-bubble ${message.direction === "outgoing" ? "outgoing" : ""}">
          <div>${escapeHtml(message.text)}</div>
          <div class="message-meta">${escapeHtml(message.direction)} · ${formatDateTime(message.createdAt)}</div>
        </div>
      `).join("") || `<div class="empty-state">Сообщений пока нет.</div>`}
    </div>
    <div class="row g-0 border-top">
      <div class="col-lg-5 border-end p-3">
        <h2 class="h6">Память диалога</h2>
        <pre class="json-box mb-0">${escapeHtml(prettyJson(conversation.memory?.memory || {}))}</pre>
      </div>
      <div class="col-lg-7 p-3">
        <h2 class="h6">Заявки и handoff</h2>
        ${appointments.map((appointment) => renderAppointmentMini(appointment)).join("") || `<div class="small-muted">Заявок нет.</div>`}
        <div class="mt-3">
          ${handoffs.map((handoff) => `
            <div class="border rounded p-2 mb-2">
              <div class="d-flex justify-content-between gap-2">
                <strong>Handoff #${handoff.id}</strong>
                ${badge(handoff.status)}
              </div>
              <div class="small-muted">${escapeHtml(handoff.reason || "-")} · ${formatDateTime(handoff.createdAt)}</div>
              ${handoff.status === "open" ? `<button class="btn btn-sm btn-outline-secondary mt-2" data-resolve-handoff="${handoff.id}">Закрыть handoff</button>` : ""}
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

function renderAppointmentMini(appointment) {
  return `
    <div class="border rounded p-2 mb-2">
      <div class="d-flex justify-content-between gap-2">
        <strong>Заявка #${appointment.id}</strong>
        ${badge(appointment.status)}
      </div>
      <div>${escapeHtml(appointment.patientName || "Без имени")} · ${escapeHtml(appointment.preferredTime || "-")} · ${formatDate(appointment.preferredDate)}</div>
      <div class="small-muted">${escapeHtml(appointment.requestedService || appointment.complaint || "Причина не указана")}</div>
    </div>
  `;
}

async function loadAppointments() {
  state.appointments.pageSize = Number($("#appointmentPageSize").value || 30);
  const query = buildQuery({
    search: $("#appointmentSearch").value.trim(),
    status: $("#appointmentStatusFilter").value,
    date_from: $("#appointmentDateFrom").value,
    date_to: $("#appointmentDateTo").value,
    page: state.appointments.page,
    page_size: state.appointments.pageSize
  });
  const { appointments, pagination } = await api(`/appointments${query}`);
  $("#appointmentCount").textContent = `${pagination.total} всего`;
  $("#appointmentsTable").innerHTML = appointments.length
    ? appointments.map((appointment) => {
        const reminders = appointment.reminders || [];
        return `
          <tr>
            <td>#${appointment.id}</td>
            <td>
              <strong>${escapeHtml(appointment.patientName || appointment.contact?.displayName || "Без имени")}</strong>
              <div class="small-muted">${escapeHtml(appointment.phone || appointment.contact?.maxUserId || "-")}</div>
            </td>
            <td>${escapeHtml(shortText(appointment.requestedService || appointment.complaint || "-", 90))}</td>
            <td>${formatDate(appointment.preferredDate)}</td>
            <td>${escapeHtml(appointment.preferredTime || "-")}</td>
            <td>
              <select class="form-select form-select-sm appointment-status" data-appointment-id="${appointment.id}">
                ${["new", "collecting", "pending", "waiting_confirmation", "confirmed", "cancelled", "needs_admin_review"].map((status) => `
                  <option value="${status}" ${appointment.status === status ? "selected" : ""}>${status}</option>
                `).join("")}
              </select>
            </td>
            <td>
              ${reminders.length ? reminders.map((reminder) => `
                <div>${badge(reminder.status)} <span class="small-muted">${escapeHtml(reminder.type)} · ${formatDateTime(reminder.remindAt)}</span></div>
              `).join("") : `<span class="small-muted">Нет</span>`}
            </td>
            <td><button class="btn btn-sm btn-outline-primary" data-save-appointment-status="${appointment.id}">Сохранить</button></td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="8" class="text-center text-secondary py-4">Заявок нет.</td></tr>`;
  renderPagination("#appointmentPagination", pagination, (page) => {
    state.appointments.page = page;
    loadAppointments().catch(showError);
  });
}

async function saveAppointmentStatus(id) {
  const select = document.querySelector(`.appointment-status[data-appointment-id="${id}"]`);
  await api(`/appointments/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status: select.value })
  });
  toast("Статус заявки сохранен");
  await loadAppointments();
}

async function loadBroadcast() {
  await Promise.all([
    loadBroadcastRecipients(),
    loadOutboundQueue()
  ]);
}

function getBroadcastFilterPayload() {
  return {
    mode: $("#broadcastMode").value,
    serviceQuery: $("#broadcastServiceQuery").value.trim(),
    visitedBeforeDays: $("#broadcastVisitedBefore").value,
    visitedAfterDays: $("#broadcastVisitedAfter").value,
    onlyWithVisits: $("#broadcastOnlyWithVisits").checked,
    pageSize: Number($("#broadcastPageSize").value || 25)
  };
}

async function loadBroadcastRecipients() {
  const filters = getBroadcastFilterPayload();
  state.broadcast.recipientsPageSize = filters.pageSize;
  const query = buildQuery({
    annual_hygiene: filters.mode === "annual_hygiene" ? "true" : "",
    service_query: filters.mode === "custom" ? filters.serviceQuery : "",
    visited_before_days: filters.mode === "custom" ? filters.visitedBeforeDays : "",
    visited_after_days: filters.mode === "custom" ? filters.visitedAfterDays : "",
    only_with_visits: filters.mode === "custom" && filters.onlyWithVisits ? "true" : "",
    page: state.broadcast.recipientsPage,
    page_size: state.broadcast.recipientsPageSize
  });
  const { recipients, count, pagination } = await api(`/broadcast/recipients${query}`);
  state.broadcast.recipients = recipients;
  $("#broadcastRecipientCount").textContent = `${count} найдено`;
  renderBroadcastRecipients();
  renderPagination("#broadcastRecipientPagination", pagination, (page) => {
    state.broadcast.recipientsPage = page;
    loadBroadcastRecipients().catch(showError);
  });
}

function renderBroadcastRecipients() {
  $("#selectBroadcastPage").checked = state.broadcast.recipients.length > 0 &&
    state.broadcast.recipients.every((recipient) => state.broadcast.selected.has(String(recipient.contact_id)));
  $("#broadcastSelectedCount").textContent = `${state.broadcast.selected.size} выбрано`;
  $("#broadcastRecipientsTable").innerHTML = state.broadcast.recipients.length
    ? state.broadcast.recipients.map((recipient) => {
      const id = String(recipient.contact_id);
      return `
        <tr>
          <td><input class="form-check-input broadcast-select" type="checkbox" data-contact-id="${escapeHtml(id)}" ${state.broadcast.selected.has(id) ? "checked" : ""}></td>
          <td>
            <strong>${escapeHtml(recipient.patient_name || recipient.display_name || "-")}</strong>
            <div class="small-muted">${escapeHtml(recipient.phone || "")}</div>
          </td>
          <td>${escapeHtml(recipient.chat_id || "-")}</td>
          <td>${escapeHtml(recipient.last_service || "-")}</td>
          <td>${escapeHtml(recipient.last_visit_date || "-")}</td>
        </tr>
      `;
    }).join("")
    : `<tr><td colspan="5" class="text-center text-secondary py-4">Получателей по фильтрам нет.</td></tr>`;
}

function selectedBroadcastIds() {
  return Array.from(state.broadcast.selected.keys());
}

function updateBroadcastSelection(contactId, checked) {
  const id = String(contactId);
  const recipient = state.broadcast.recipients.find((item) => String(item.contact_id) === id);
  if (checked && recipient) state.broadcast.selected.set(id, recipient);
  if (!checked) state.broadcast.selected.delete(id);
  renderBroadcastRecipients();
}

async function dryRunManualBroadcast() {
  const contactIds = selectedBroadcastIds();
  if (!contactIds.length) {
    toast("Выберите получателей");
    return;
  }
  const result = await api("/broadcast/manual", {
    method: "POST",
    body: JSON.stringify({
      contact_ids: contactIds,
      message: $("#manualBroadcastMessage").value,
      dry_run: true,
      send_window: {
        start: $("#broadcastWindowStart").value,
        end: $("#broadcastWindowEnd").value
      }
    })
  });
  renderManualBroadcastPreview(result.recipients || []);
  toast(`Предпросмотр: ${result.recipients_found} получателей`);
}

function renderManualBroadcastPreview(recipients) {
  $("#manualBroadcastDryRunResult").innerHTML = recipients.length
    ? recipients.map((recipient) => `
      <div class="preview-item">
        <div class="fw-semibold">${escapeHtml(recipient.patient_name || recipient.display_name || recipient.chat_id)}</div>
        <div class="small-muted">${escapeHtml(recipient.chat_id || "")}</div>
        <div class="mt-2">${escapeHtml(recipient.preview || "")}</div>
      </div>
    `).join("")
    : `<div class="empty-state">Предпросмотр пуст.</div>`;
}

async function sendManualBroadcast() {
  const contactIds = selectedBroadcastIds();
  if (!contactIds.length) {
    toast("Выберите получателей");
    return;
  }
  const result = await api("/broadcast/manual", {
    method: "POST",
    body: JSON.stringify({
      contact_ids: contactIds,
      message: $("#manualBroadcastMessage").value,
      dry_run: false,
      send_window: {
        start: $("#broadcastWindowStart").value,
        end: $("#broadcastWindowEnd").value
      }
    })
  });
  toast(`В очередь добавлено: ${result.queued}`);
  await loadOutboundQueue();
}

async function createBroadcastCampaign() {
  const filters = getBroadcastFilterPayload();
  const isAnnual = filters.mode === "annual_hygiene";
  const body = isAnnual
    ? {
        annual_hygiene: true,
        prompt: $("#broadcastPrompt").value,
        limit: filters.pageSize,
        use_ai: $("#broadcastUseAi").checked
      }
    : {
        name: $("#broadcastName").value,
        prompt: $("#broadcastPrompt").value,
        filters: {
          serviceQuery: filters.serviceQuery,
          visitedBeforeDays: Number(filters.visitedBeforeDays || 0),
          visitedAfterDays: Number(filters.visitedAfterDays || 0),
          onlyWithVisits: filters.onlyWithVisits,
          limit: 200
        },
        type: "broadcast",
        use_ai: $("#broadcastUseAi").checked
      };
  const result = await api("/broadcast", {
    method: "POST",
    body: JSON.stringify(body)
  });
  toast(`Кампания создана: ${result.queued} сообщений`);
  await loadOutboundQueue();
}

async function loadOutboundQueue() {
  state.broadcast.outboundPageSize = Number($("#outboundPageSize").value || 30);
  const query = buildQuery({
    search: $("#outboundSearch").value.trim(),
    status: $("#outboundStatusFilter").value,
    type: $("#outboundTypeFilter").value,
    page: state.broadcast.outboundPage,
    page_size: state.broadcast.outboundPageSize
  });
  const { items, stats, pagination } = await api(`/broadcast/outbound-queue${query}`);
  const statsText = Object.entries(stats || {}).map(([key, value]) => `${key}: ${value}`).join(" · ");
  $("#outboundQueueCount").textContent = statsText || `${pagination.total} всего`;
  $("#outboundQueueTable").innerHTML = items.length
    ? items.map((item) => `
      <tr>
        <td>#${item.id}</td>
        <td>
          <strong>${escapeHtml(item.recipientName || item.contact?.displayName || item.chatName || "-")}</strong>
          <div class="small-muted">${escapeHtml(item.chatId)}</div>
        </td>
        <td>${escapeHtml(item.type)}</td>
        <td>${badge(item.status)}</td>
        <td title="${escapeHtml(item.messageText)}">${escapeHtml(shortText(item.messageText, 92))}</td>
        <td>${formatDateTime(item.sentAt || item.scheduledAt || item.createdAt)}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="6" class="text-center text-secondary py-4">Очередь пуста.</td></tr>`;
  renderPagination("#outboundPagination", pagination, (page) => {
    state.broadcast.outboundPage = page;
    loadOutboundQueue().catch(showError);
  });
}

async function loadPrompts() {
  if (state.promptsLoaded) return;
  const data = await api("/prompts");
  $("#systemPromptInput").value = data.systemPrompt;
  $("#clinicKnowledgeInput").value = data.clinicKnowledge;
  state.promptsLoaded = true;
}

async function savePrompts() {
  await api("/prompts", {
    method: "PUT",
    body: JSON.stringify({
      systemPrompt: $("#systemPromptInput").value,
      clinicKnowledge: $("#clinicKnowledgeInput").value
    })
  });
  toast("Промпты сохранены");
}

async function loadTables() {
  if (!state.tablesLoaded) {
    const { tables } = await api("/db/tables");
    $("#dbTableSelect").innerHTML = tables.map((table) => `<option value="${table}">${table}</option>`).join("");
    state.tablesLoaded = true;
  }
  await loadDbTable();
}

async function loadDbTable() {
  state.database.pageSize = Number($("#dbPageSize").value || 50);
  const table = $("#dbTableSelect").value;
  if (!table) return;
  const query = buildQuery({
    page: state.database.page,
    page_size: state.database.pageSize
  });
  const { rows, pagination } = await api(`/db/${table}${query}`);
  state.database.rows = rows;
  state.database.columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  renderDbRows();
  renderPagination("#dbPagination", pagination, (page) => {
    state.database.page = page;
    loadDbTable().catch(showError);
  });
}

function renderDbRows() {
  const table = $("#dbTable");
  const filter = $("#dbClientFilter").value.trim().toLowerCase();
  const rows = filter
    ? state.database.rows.filter((row) => JSON.stringify(row).toLowerCase().includes(filter))
    : state.database.rows;
  const columns = state.database.columns;

  if (!rows.length) {
    table.innerHTML = `<tbody><tr><td class="text-center text-secondary py-4">Записей нет.</td></tr></tbody>`;
    return;
  }

  table.innerHTML = `
    <thead>
      <tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>
    </thead>
    <tbody>
      ${rows.map((row) => `
        <tr>
          ${columns.map((column) => {
            const value = row[column];
            const text = typeof value === "object" && value !== null ? JSON.stringify(value) : value;
            return `<td title="${escapeHtml(text)}">${escapeHtml(text)}</td>`;
          }).join("")}
        </tr>
      `).join("")}
    </tbody>
  `;
}

async function sendTestMessage() {
  const result = await api("/test-message", {
    method: "POST",
    body: JSON.stringify({
      display_name: $("#testDisplayName").value,
      message_text: $("#testMessageText").value
    })
  });
  $("#testResult").textContent = prettyJson(result);
  toast("Тест обработан");
}

function bindEvents() {
  $all("[data-page]").forEach((button) => {
    button.addEventListener("click", () => setPage(button.dataset.page));
  });

  $("#refreshAllButton").addEventListener("click", () => {
    pageLoaders[state.activePage]?.().then(() => toast("Обновлено")).catch(showError);
  });

  $("#copyReportButton").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#todayReport").textContent);
    toast("Отчет скопирован");
  });

  $("#conversationSearchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.conversations.page = 1;
    loadConversations().catch(showError);
  });

  $("#conversationStatusFilter").addEventListener("change", () => {
    state.conversations.page = 1;
    loadConversations().catch(showError);
  });

  $("#conversationPageSize").addEventListener("change", () => {
    state.conversations.page = 1;
    loadConversations().catch(showError);
  });

  $("#conversationList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-conversation-id]");
    if (!button) return;
    loadConversation(button.dataset.conversationId).catch(showError);
  });

  $("#conversationDetail").addEventListener("click", async (event) => {
    const resetButton = event.target.closest("[data-reset-conversation-context]");
    if (resetButton) {
      const ok = window.confirm("Сбросить память диалога, закрыть handoff и начать новый контекст для этого контакта?");
      if (!ok) return;
      await api(`/conversations/${resetButton.dataset.resetConversationContext}/reset-context`, { method: "POST" });
      toast("Контекст сброшен");
      await loadConversation(resetButton.dataset.resetConversationContext);
      return;
    }

    const button = event.target.closest("[data-resolve-handoff]");
    if (!button) return;
    await api(`/handoffs/${button.dataset.resolveHandoff}/resolve`, { method: "PATCH" });
    toast("Handoff закрыт");
    await loadConversation(state.selectedConversationId);
  });

  $("#appointmentFilterForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.appointments.page = 1;
    loadAppointments().catch(showError);
  });

  $("#appointmentStatusFilter").addEventListener("change", () => {
    state.appointments.page = 1;
    loadAppointments().catch(showError);
  });

  $("#appointmentPageSize").addEventListener("change", () => {
    state.appointments.page = 1;
    loadAppointments().catch(showError);
  });

  $("#appointmentsTable").addEventListener("click", (event) => {
    const button = event.target.closest("[data-save-appointment-status]");
    if (!button) return;
    saveAppointmentStatus(button.dataset.saveAppointmentStatus).catch(showError);
  });

  $("#broadcastRecipientForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.broadcast.recipientsPage = 1;
    loadBroadcastRecipients().catch(showError);
  });

  $("#broadcastPageSize").addEventListener("change", () => {
    state.broadcast.recipientsPage = 1;
    loadBroadcastRecipients().catch(showError);
  });

  $("#selectBroadcastPage").addEventListener("change", (event) => {
    state.broadcast.recipients.forEach((recipient) => {
      if (event.target.checked) state.broadcast.selected.set(String(recipient.contact_id), recipient);
      else state.broadcast.selected.delete(String(recipient.contact_id));
    });
    renderBroadcastRecipients();
  });

  $("#broadcastRecipientsTable").addEventListener("change", (event) => {
    const checkbox = event.target.closest(".broadcast-select");
    if (!checkbox) return;
    updateBroadcastSelection(checkbox.dataset.contactId, checkbox.checked);
  });

  $("#clearBroadcastSelectionButton").addEventListener("click", () => {
    state.broadcast.selected.clear();
    renderBroadcastRecipients();
  });

  $("#dryRunManualBroadcastButton").addEventListener("click", () => dryRunManualBroadcast().catch(showError));
  $("#sendManualBroadcastButton").addEventListener("click", () => sendManualBroadcast().catch(showError));
  $("#createBroadcastButton").addEventListener("click", () => createBroadcastCampaign().catch(showError));

  $("#outboundQueueForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.broadcast.outboundPage = 1;
    loadOutboundQueue().catch(showError);
  });

  $("#outboundStatusFilter").addEventListener("change", () => {
    state.broadcast.outboundPage = 1;
    loadOutboundQueue().catch(showError);
  });

  $("#outboundTypeFilter").addEventListener("change", () => {
    state.broadcast.outboundPage = 1;
    loadOutboundQueue().catch(showError);
  });

  $("#outboundPageSize").addEventListener("change", () => {
    state.broadcast.outboundPage = 1;
    loadOutboundQueue().catch(showError);
  });

  $("#savePromptsButton").addEventListener("click", () => savePrompts().catch(showError));

  $("#dbFilterForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.database.page = 1;
    loadDbTable().catch(showError);
  });

  $("#dbTableSelect").addEventListener("change", () => {
    state.database.page = 1;
    loadDbTable().catch(showError);
  });

  $("#dbPageSize").addEventListener("change", () => {
    state.database.page = 1;
    loadDbTable().catch(showError);
  });

  $("#dbClientFilter").addEventListener("input", () => renderDbRows());
  $("#sendTestMessageButton").addEventListener("click", () => sendTestMessage().catch(showError));

  $("#latestMessages").addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-conversation]");
    if (!button) return;
    setPage("conversations");
    loadConversation(button.dataset.openConversation).catch(showError);
  });
}

bindEvents();
setPage("dashboard");

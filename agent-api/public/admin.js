const apiBase = "/api/admin";
const state = {
  activePage: "dashboard",
  selectedConversationId: null,
  promptsLoaded: false,
  tablesLoaded: false
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
  return `${text.slice(0, length - 1)}...`;
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
    confirmed: "text-bg-success",
    pending: "text-bg-warning",
    new: "text-bg-primary",
    open: "text-bg-danger",
    resolved: "text-bg-secondary",
    cancelled: "text-bg-dark",
    failed: "text-bg-danger",
    sent: "text-bg-success"
  }[value] || "text-bg-light border";

  return `<span class="badge ${tone}">${text}</span>`;
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

function setPage(page) {
  state.activePage = page;
  document.querySelectorAll(".page-section").forEach((section) => {
    section.classList.toggle("active", section.id === `page-${page}`);
  });
  document.querySelectorAll(".sidebar .nav-link").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page);
  });
  pageLoaders[page]?.().catch(showError);
}

function showError(error) {
  console.error(error);
  toast(error.message || "Ошибка");
}

async function loadDashboard() {
  const { stats, report, latestMessages } = await api("/stats");
  const cards = [
    ["Контакты", stats.contacts, `Новых сегодня: ${stats.contactsToday}`],
    ["Активные диалоги", stats.activeConversations, "Открытые conversation"],
    ["Сообщения", stats.messages, `Сегодня: ${stats.messagesToday}`],
    ["Заявки", stats.appointments, `Сегодня: ${stats.appointmentsToday}`],
    ["Handoff", stats.openHandoffs, "Открытых передач"],
    ["Напоминания", stats.pendingReminders, "Ожидают отправки"]
  ];

  $("#statsGrid").innerHTML = cards.map(([label, value, hint]) => `
    <div class="col-md-4 col-xl-2">
      <div class="stat-card">
        <div class="label">${escapeHtml(label)}</div>
        <div class="value mt-2">${escapeHtml(value)}</div>
        <div class="small-muted mt-2">${escapeHtml(hint)}</div>
      </div>
    </div>
  `).join("");

  $("#todayReport").textContent = report;
  $("#latestMessages").innerHTML = latestMessages.length
    ? latestMessages.map((message) => `
      <button class="list-group-item list-group-item-action" data-open-conversation="${message.conversationId}">
        <div class="d-flex justify-content-between gap-3">
          <strong>${escapeHtml(message.contact?.displayName || message.contact?.maxUserId || `Контакт ${message.contactId}`)}</strong>
          <span class="small-muted">${formatDateTime(message.createdAt)}</span>
        </div>
        <div class="small-muted">${escapeHtml(message.direction)} / ${escapeHtml(message.role)}</div>
        <div>${escapeHtml(shortText(message.text, 150))}</div>
      </button>
    `).join("")
    : `<div class="p-3 small-muted">Пока нет сообщений.</div>`;
}

async function loadConversations() {
  const search = encodeURIComponent($("#conversationSearch").value.trim());
  const { conversations } = await api(`/conversations${search ? `?search=${search}` : ""}`);
  $("#conversationList").innerHTML = conversations.length
    ? conversations.map((conversation) => {
        const contact = conversation.contact || {};
        const last = conversation.messages?.[0];
        const isActive = conversation.id === state.selectedConversationId ? "active" : "";
        return `
          <button class="conversation-item ${isActive}" data-conversation-id="${conversation.id}">
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
    <div class="panel-header">
      <div class="d-flex justify-content-between gap-3">
        <div>
          <div class="fw-semibold">${escapeHtml(contact.displayName || contact.maxUserId || `Контакт ${conversation.contactId}`)}</div>
          <div class="small-muted">${escapeHtml(contact.maxUserId || "-")} · ${escapeHtml(conversation.channel || "-")}</div>
        </div>
        <div>${badge(conversation.status)}</div>
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
  const status = encodeURIComponent($("#appointmentStatusFilter").value);
  const { appointments } = await api(`/appointments${status ? `?status=${status}` : ""}`);
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
                ${["new", "collecting", "pending", "waiting_confirmation", "confirmed", "cancelled", "needs_admin_review"].map((statusOption) => `
                  <option value="${statusOption}" ${appointment.status === statusOption ? "selected" : ""}>${statusOption}</option>
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
}

async function loadBroadcast() {
  await Promise.all([
    previewBroadcastRecipients(),
    loadOutboundQueue()
  ]);
}

function getBroadcastPayload() {
  const mode = $("#broadcastMode").value;
  const limit = Number($("#broadcastLimit").value || 100);
  return {
    mode,
    annual_hygiene: mode === "annual_hygiene",
    name: $("#broadcastName").value,
    prompt: $("#broadcastPrompt").value,
    limit,
    use_ai: $("#broadcastUseAi").checked,
    filters: {
      serviceQuery: $("#broadcastServiceQuery").value,
      visitedBeforeDays: Number($("#broadcastVisitedBefore").value || 0),
      onlyWithVisits: true,
      limit
    }
  };
}

async function previewBroadcastRecipients() {
  const payload = getBroadcastPayload();
  const params = new URLSearchParams({
    limit: String(payload.limit)
  });

  if (payload.annual_hygiene) {
    params.set("annual_hygiene", "true");
  } else {
    if (payload.filters.serviceQuery) params.set("service_query", payload.filters.serviceQuery);
    if (payload.filters.visitedBeforeDays) params.set("visited_before_days", String(payload.filters.visitedBeforeDays));
    params.set("only_with_visits", "true");
  }

  const { recipients, count } = await api(`/broadcast/recipients?${params.toString()}`);
  $("#broadcastRecipientCount").textContent = `${count} получ.`;
  $("#broadcastRecipientsTable").innerHTML = recipients.length
    ? recipients.map((recipient) => `
      <tr>
        <td>
          <strong>${escapeHtml(recipient.patient_name || recipient.display_name || "-")}</strong>
          <div class="small-muted">${escapeHtml(recipient.phone || "")}</div>
        </td>
        <td>${escapeHtml(recipient.chat_id || "-")}</td>
        <td>${escapeHtml(recipient.last_service || "-")}</td>
        <td>${escapeHtml(recipient.last_visit_date || "-")}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="4" class="text-center text-secondary py-4">Получателей по фильтрам пока нет.</td></tr>`;
}

async function createBroadcast() {
  const payload = getBroadcastPayload();
  const body = payload.annual_hygiene
    ? {
        annual_hygiene: true,
        prompt: payload.prompt,
        limit: payload.limit,
        use_ai: payload.use_ai
      }
    : {
        name: payload.name,
        prompt: payload.prompt,
        filters: payload.filters,
        type: "broadcast",
        use_ai: payload.use_ai
      };

  const result = await api("/broadcast", {
    method: "POST",
    body: JSON.stringify(body)
  });

  toast(`Рассылка создана: ${result.queued} сообщений в очереди`);
  await loadBroadcast();
}

async function loadOutboundQueue() {
  const { items, stats } = await api("/broadcast/outbound-queue?limit=80");
  const statsText = Object.entries(stats || {}).map(([key, value]) => `${key}: ${value}`).join(" · ");
  if (statsText) $("#reloadOutboundQueueButton").textContent = `Обновить очередь (${statsText})`;

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
        <td title="${escapeHtml(item.messageText)}">${escapeHtml(shortText(item.messageText, 80))}</td>
        <td>${formatDateTime(item.sentAt || item.scheduledAt || item.createdAt)}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="6" class="text-center text-secondary py-4">Очередь пуста.</td></tr>`;
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
  toast("Промты сохранены. Новые ответы будут использовать обновленный контекст.");
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
  const table = $("#dbTableSelect").value;
  if (!table) return;
  const { rows } = await api(`/db/${table}`);
  renderDbRows(rows);
}

function renderDbRows(rows) {
  const table = $("#dbTable");
  if (!rows.length) {
    table.innerHTML = `<tbody><tr><td class="text-center text-secondary py-4">Записей нет.</td></tr></tbody>`;
    return;
  }

  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
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
  toast("Тестовое сообщение обработано");
}

document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", () => setPage(button.dataset.page));
});

$("#refreshAllButton").addEventListener("click", () => {
  pageLoaders[state.activePage]?.().then(() => toast("Обновлено")).catch(showError);
});

$("#copyReportButton").addEventListener("click", async () => {
  try {
    const text = $("#todayReport").textContent;
    await navigator.clipboard.writeText(text);
    toast("Отчет скопирован");
  } catch (error) {
    showError(error);
  }
});

$("#conversationSearchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  loadConversations().catch(showError);
});

$("#conversationList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-conversation-id]");
  if (!button) return;
  loadConversation(button.dataset.conversationId).catch(showError);
});

$("#conversationDetail").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-resolve-handoff]");
  if (!button) return;
  await api(`/handoffs/${button.dataset.resolveHandoff}/resolve`, { method: "PATCH" });
  toast("Handoff закрыт");
  await loadConversation(state.selectedConversationId);
});

$("#reloadAppointmentsButton").addEventListener("click", () => loadAppointments().catch(showError));
$("#previewBroadcastButton").addEventListener("click", () => previewBroadcastRecipients().catch(showError));
$("#createBroadcastButton").addEventListener("click", () => createBroadcast().catch(showError));
$("#reloadOutboundQueueButton").addEventListener("click", () => loadOutboundQueue().catch(showError));
$("#broadcastMode").addEventListener("change", () => previewBroadcastRecipients().catch(showError));

$("#appointmentsTable").addEventListener("click", (event) => {
  const button = event.target.closest("[data-save-appointment-status]");
  if (!button) return;
  saveAppointmentStatus(button.dataset.saveAppointmentStatus).catch(showError);
});

$("#savePromptsButton").addEventListener("click", () => savePrompts().catch(showError));
$("#loadDbTableButton").addEventListener("click", () => loadDbTable().catch(showError));
$("#sendTestMessageButton").addEventListener("click", () => sendTestMessage().catch(showError));

$("#latestMessages").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-conversation]");
  if (!button) return;
  setPage("conversations");
  loadConversation(button.dataset.openConversation).catch(showError);
});

setPage("dashboard");

import { readFile } from "node:fs/promises";
import Groq from "groq-sdk";
import { config } from "./config.js";
import { getClinicKnowledgeContext } from "./clinicDataService.js";
import { parseJsonObject } from "./json.js";

const promptPath = new URL("../../prompts/dental_admin_system_prompt.md", import.meta.url);
const knowledgePath = new URL("../../prompts/clinic_knowledge.md", import.meta.url);

const structuredOutputPrompt = `
Верни только JSON без markdown.
Формат:
{
  "reply": "короткий ответ клиенту на русском",
  "intent": "consultation | book_appointment | price_question | clarification | handoff | other",
  "urgency": "low | normal | high | urgent",
  "should_create_appointment_request": false,
  "should_handoff": false,
  "handoff_reason": null,
  "memory_update": {
    "patient_name": null,
    "phone": null,
    "intent": null,
    "preferred_time": null,
    "preferred_date": null,
    "complaint": null,
    "requested_service": null,
    "preferred_doctor": null,
    "urgency": null,
    "consent_to_book": null
  }
}

Правила JSON:
- Если клиент спрашивает цену, intent = "price_question".
- Если клиент хочет записаться, intent = "book_appointment".
- Если клиент просто спрашивает про услуги, цены или условия, сначала ответь по вопросу. Не превращай любой вопрос в запись.
- Если есть тревожные симптомы, should_handoff = true.
- should_create_appointment_request = true только когда заявка достаточно собрана.
- В memory_update записывай только факты из диалога, не выдумывай телефон, дату, врача или услугу.
- Не повторяй полное имя клиента в каждом ответе. Если нужно обратиться, используй имя без фамилии.
- Пиши естественно: 1-3 коротких предложения, без одинаковых шаблонов подряд.
`;

function toGroqHistory(messages) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.text
  }));
}

function fallbackResponse(userMessage, memory = {}) {
  const riskyWords = [
    "отек",
    "опух",
    "температур",
    "кров",
    "травм",
    "сильная боль",
    "дышать",
    "глотать"
  ];
  const lower = userMessage.toLowerCase();
  const risky = riskyWords.some((word) => lower.includes(word));
  const name = memory?.patient_name ? `${String(memory.patient_name).split(/\s+/u)[0]}, ` : "";

  if (risky) {
    return {
      reply: "Понимаю. При таких симптомах лучше срочно связаться с клиникой или обратиться за неотложной помощью. Я передам обращение администратору.",
      intent: "handoff",
      urgency: "urgent",
      should_create_appointment_request: false,
      should_handoff: true,
      handoff_reason: "urgent_symptoms",
      memory_update: { urgency: "urgent", complaint: userMessage }
    };
  }

  if (/(услуг|что есть|какая услуга|по услуг|сервис)/iu.test(lower)) {
    return {
      reply: `${name}у нас есть терапия, гигиена, хирургия, ортопедия, имплантация, ортодонтия и детская стоматология. Могу сориентировать по цене или помочь записаться.`,
      intent: "consultation",
      urgency: "low",
      should_create_appointment_request: false,
      should_handoff: false,
      handoff_reason: null,
      memory_update: {}
    };
  }

  if (/(гигиен|чистк|air\s*flow|аир\s*флоу)/iu.test(lower)) {
    return {
      reply: `${name}профгигиена стоит от 4500 рублей, Air Flow отдельно от 3000. Точнее скажет врач после осмотра. Хотите записаться на гигиену?`,
      intent: "consultation",
      urgency: "low",
      should_create_appointment_request: false,
      should_handoff: false,
      handoff_reason: null,
      memory_update: {
        requested_service: "профессиональная гигиена",
        complaint: "профессиональная гигиена"
      }
    };
  }

  if (/(цен|стоимост|сколько стоит|прайс)/iu.test(lower)) {
    return {
      reply: `${name}могу сориентировать по цене, но точная сумма зависит от осмотра и снимка. Напишите, какая услуга интересует: кариес, гигиена, удаление, коронка или что-то другое?`,
      intent: "price_question",
      urgency: "low",
      should_create_appointment_request: false,
      should_handoff: false,
      handoff_reason: null,
      memory_update: {}
    };
  }

  if (/(минет|секс|нах|хуй|пизд|еба|ёба|бля)/iu.test(lower)) {
    return {
      reply: `${name}я по стоматологии. Могу подсказать по услугам, ценам или записать на прием.`,
      intent: "other",
      urgency: "low",
      should_create_appointment_request: false,
      should_handoff: false,
      handoff_reason: null,
      memory_update: {}
    };
  }

  if (/^(привет|приветствую|здравствуйте|добрый день|добрый вечер|дратути|алло|ало)[!.?\s]*$/iu.test(lower.trim())) {
    return {
      reply: `${name || "Здравствуйте! "}Подскажу по услугам, ценам или помогу записаться. Что интересует?`.replace(/^([А-ЯЁа-яё-]+, )Подскажу/u, "$1подскажу"),
      intent: "consultation",
      urgency: "low",
      should_create_appointment_request: false,
      should_handoff: false,
      handoff_reason: null,
      memory_update: {}
    };
  }

  return {
    reply: `${name}поняла. Напишите, что нужно: консультация по услуге, цена или запись на прием?`,
    intent: "clarification",
    urgency: "low",
    should_create_appointment_request: false,
    should_handoff: false,
    handoff_reason: null,
    memory_update: {}
  };
}

async function readTextFile(fileUrl) {
  try {
    return await readFile(fileUrl, "utf8");
  } catch (error) {
    console.warn(`Optional prompt file was not loaded: ${fileUrl.pathname}`, error.message);
    return "";
  }
}

function inferFromMessage(userMessage) {
  const lower = userMessage.toLowerCase();
  const asksPrice = [
    "цена",
    "стоимость",
    "сколько стоит",
    "прайс",
    "price",
    "cost"
  ].some((word) => lower.includes(word));
  const hasPain = [
    "болит",
    "боль",
    "зуб",
    "ноет",
    "десна",
    "tooth",
    "teeth",
    "pain",
    "ache"
  ].some((word) => lower.includes(word));
  const wantsBooking = [
    "запис",
    "прием",
    "приём",
    "окно",
    "талон",
    "врач",
    "book",
    "appointment",
    "visit",
    "doctor"
  ].some((word) => lower.includes(word));
  const saysHelloOnly = /^(здравствуйте|здравствуй|добрый день|добрый вечер|привет)[!. ]*$/i.test(lower.trim());

  if (asksPrice && !wantsBooking) {
    return {
      intent: "price_question",
      urgency: "low"
    };
  }

  if (hasPain && wantsBooking) {
    return {
      intent: "book_appointment",
      urgency: "normal",
      memory_update: {
        intent: "book_appointment",
        complaint: userMessage,
        urgency: "normal"
      }
    };
  }

  if (wantsBooking) {
    return {
      intent: "book_appointment",
      urgency: "normal",
      memory_update: {
        intent: "book_appointment",
        urgency: "normal"
      }
    };
  }

  if (hasPain) {
    return {
      intent: "consultation",
      urgency: "normal",
      memory_update: {
        complaint: userMessage,
        urgency: "normal"
      }
    };
  }

  if (saysHelloOnly) {
    return {
      intent: "consultation",
      urgency: "low"
    };
  }

  return {};
}

function improveAgentResult(result, userMessage) {
  const inferred = inferFromMessage(userMessage);
  const extracted = extractFactsFromMessage(userMessage);
  const memoryUpdate = {
    ...(result.memory_update || {}),
    ...(inferred.memory_update || {}),
    ...extracted
  };

  return {
    ...result,
    reply: sanitizeReply(
      makeReplyContextual({
        reply: inferred.reply || result.reply,
        extracted,
        memoryUpdate,
        userMessage
      })
    ),
    intent: inferred.intent || result.intent,
    urgency: inferred.urgency || result.urgency,
    should_create_appointment_request: Boolean(result.should_create_appointment_request),
    memory_update: memoryUpdate
  };
}

function sanitizeReply(reply = "") {
  return String(reply)
    .replace(/есть свободные слоты/giu, "можно зафиксировать пожелание по времени")
    .replace(/запись возможна/giu, "можно передать заявку на запись")
    .replace(/вы можете прийти/giu, "можно зафиксировать пожелание на визит")
    .replace(/можете прийти/giu, "можно зафиксировать пожелание на визит")
    .trim();
}

function makeReplyContextual({ reply = "", extracted = {}, memoryUpdate = {}, userMessage = "" }) {
  const text = String(reply || "").trim();
  const patientName = extracted.patient_name || memoryUpdate.patient_name;
  const lowerReply = text.toLowerCase();
  const lowerMessage = String(userMessage || "").toLowerCase();

  const repeatsMenu =
    /чем могу помочь:?\s*подсказать по услугам/i.test(lowerReply) ||
    /подсказать по услугам.*стоимости.*запис/i.test(lowerReply);

  if (patientName && repeatsMenu) {
    return `Хорошо, ${patientName}. Что беспокоит или на какую услугу записать?`;
  }

  if (patientName && lowerReply.includes("ваше имя")) {
    if (/зуб|бол|ноет|десн/iu.test(userMessage)) {
      return `Понимаю, ${patientName}, с зубной болью лучше не тянуть. Когда удобно подойти на прием?`;
    }

    return text.replace(/подскажите,\s*пожалуйста,\s*ваше имя\s*и\s*/iu, "Напишите, ");
  }

  if (patientName && /меня .*зовут|зовут меня|я\s+[а-яёa-z-]{2,}/iu.test(lowerMessage) && lowerReply.includes("чем могу помочь")) {
    return `Хорошо, ${patientName}. Что беспокоит или когда удобно подойти на прием?`;
  }

  return text;
}

function extractFactsFromMessage(userMessage) {
  const text = String(userMessage || "");
  const lower = text.toLowerCase();
  const facts = {};

  const phoneMatch = text.match(/(?:\+?\d[\d\s().-]{8,}\d)/);
  if (phoneMatch) {
    facts.phone = phoneMatch[0].replace(/[^\d+]/g, "");
  }

  const namePatterns = [
    /(?:меня зовут|мое имя|моё имя|имя)\s+([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]{1,40})/u,
    /меня\s+([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]{1,40})\s+зовут/u,
    /зовут\s+меня\s+([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]{1,40})/u,
    /^я\s+([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]{1,40})$/u
  ];
  const nameMatch = namePatterns.map((pattern) => text.match(pattern)).find(Boolean);
  if (nameMatch) {
    facts.patient_name = normalizeName(nameMatch[1]);
  }

  const timeMatch = text.match(/(?:\bв|\bна|после)\s*(\d{1,2})(?::(\d{2}))?/u);
  if (timeMatch) {
    const hours = timeMatch[1].padStart(2, "0");
    const minutes = timeMatch[2] || "00";
    facts.preferred_time = `${hours}:${minutes}`;
  }

  if (lower.includes("завтра")) {
    facts.preferred_date = addDaysIso(1);
  } else if (lower.includes("сегодня")) {
    facts.preferred_date = addDaysIso(0);
  }

  const serviceMap = [
    ["кариес", "лечение кариеса"],
    ["пульпит", "лечение пульпита"],
    ["лечение", "лечение зубов"],
    ["чистк", "профессиональная гигиена"],
    ["гигиен", "профессиональная гигиена"],
    ["удален", "удаление зуба"],
    ["удалит", "удаление зуба"],
    ["имплант", "имплантация"],
    ["коронк", "ортопедия, коронка"],
    ["брекет", "ортодонтия"],
    ["элайнер", "ортодонтия"],
    ["консультац", "консультация стоматолога"]
  ];
  const service = serviceMap.find(([marker]) => lower.includes(marker))?.[1];
  if (service) {
    facts.requested_service = service;
    facts.complaint = service;
  }

  if (/(согласн|подтверждаю|передать заявку|оформите|записывайте|давайте запиш)/iu.test(lower)) {
    facts.consent_to_book = true;
  }

  return facts;
}

function addDaysIso(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

export async function generateAgentResponse({ userMessage, history, memory }) {
  if (!config.groqApiKey || config.groqApiKey === "your_groq_api_key_here") {
    return improveAgentResult(fallbackResponse(userMessage, memory), userMessage);
  }

  const groq = new Groq({ apiKey: config.groqApiKey });
  const systemPrompt = await readTextFile(promptPath);
  const clinicKnowledge = await readTextFile(knowledgePath);
  const dbClinicKnowledge = await getClinicKnowledgeContext();
  const currentDate = new Date().toISOString().slice(0, 10);

  let response;
  try {
    response = await groq.chat.completions.create({
      model: config.groqModel,
      temperature: 0.78,
      max_tokens: config.groqMaxTokens,
      messages: [
        {
          role: "system",
          content: [
            systemPrompt,
            clinicKnowledge ? `База знаний клиники:\n${clinicKnowledge}` : "",
            dbClinicKnowledge ? `Актуальные справочники клиники из PostgreSQL:\n${dbClinicKnowledge}` : "",
            structuredOutputPrompt,
            `Клиника: ${config.clinicName}`,
            config.clinicPhone ? `Телефон клиники: ${config.clinicPhone}` : "",
            config.clinicAddress ? `Адрес клиники: ${config.clinicAddress}` : "",
            `Текущая дата: ${currentDate}`,
            `Текущая память диалога: ${JSON.stringify(memory || {})}`
          ].filter(Boolean).join("\n\n")
        },
        ...toGroqHistory(history),
        { role: "user", content: userMessage }
      ]
    });
  } catch (error) {
    console.warn("Groq request failed, using local fallback:", error.message);
    return improveAgentResult({
      ...fallbackResponse(userMessage, memory),
      model_error: error.message
    }, userMessage);
  }

  const text = response.choices?.[0]?.message?.content || "";
  const parsed = parseJsonObject(text);

  if (!parsed?.reply) {
    return improveAgentResult({
      ...fallbackResponse(userMessage, memory),
      raw_model_response: text
    }, userMessage);
  }

  return improveAgentResult({
    reply: parsed.reply,
    intent: parsed.intent || "other",
    urgency: parsed.urgency || "normal",
    should_create_appointment_request: Boolean(parsed.should_create_appointment_request),
    should_handoff: Boolean(parsed.should_handoff),
    handoff_reason: parsed.handoff_reason || null,
    memory_update: parsed.memory_update || {}
  }, userMessage);
}

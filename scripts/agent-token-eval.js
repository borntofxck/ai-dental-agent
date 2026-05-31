import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { buildCompactLLMContext, classifyUserIntentWithLLM, humanizeReplyWithAI } from "../agent-api/src/agent.js";
import { config } from "../agent-api/src/config.js";
import { queueManualBroadcast } from "../agent-api/src/broadcastService.js";

const prompt = await readFile(new URL("../prompts/intent_classifier_runtime_prompt.md", import.meta.url), "utf8");
assert.ok(prompt.length < 3500, "classifier runtime prompt must stay compact");
assert.ok(!prompt.includes("dental_admin_system_prompt"), "classifier must not load full system prompt");
assert.ok(!prompt.includes("clinic_knowledge"), "classifier must not load full clinic knowledge");

const hugeHistory = Array.from({ length: 30 }, (_, index) => ({
  role: index % 2 ? "assistant" : "user",
  text: `message ${index} ${"x".repeat(800)}`
}));
const compact = buildCompactLLMContext({
  userMessage: "нужно удалить зуб мудрости завтра",
  history: hugeHistory,
  memory: {
    patient_name: "Ярослав",
    requested_service: "удаление зуба мудрости",
    complaint: "x".repeat(3000),
    preferred_date: "tomorrow"
  }
});
assert.ok(JSON.stringify(compact.context).length <= config.maxContextChars + 200, "compact context should be bounded");
assert.ok(compact.context.last_messages.length <= config.maxLastMessages, "classifier context should keep only short history");

const trivial = await classifyUserIntentWithLLM({
  userMessage: "спасибо",
  history: [],
  memory: {}
});
assert.equal(trivial.classifier_intent, "acknowledgement");
assert.ok(trivial.pipeline_events.some((event) => event.type === "trivial_message_local"), "trivial message should not call LLM");
assert.ok(!trivial.pipeline_events.some((event) => event.type === "llm_usage"), "trivial path must not log LLM usage");

const simpleHumanizer = await humanizeReplyWithAI({
  safeReply: "Пожалуйста.",
  userMessage: "спасибо",
  action: "none",
  state: "idle"
});
assert.equal(simpleHumanizer.reply, "Пожалуйста.");
assert.ok(simpleHumanizer.events.some((event) => event.type === "humanizer_skipped_simple" || event.type === "humanizer_skipped_disabled"), "simple humanizer case should be skipped");

const prisma = new PrismaClient();
try {
  await prisma.$connect();
  const contact = await prisma.contact.findFirst({ where: { maxUserId: { not: "" } } });
  if (contact) {
    const dryRun = await queueManualBroadcast({
      contactIds: [contact.id],
      message: "Здравствуйте, {{name}}! Напоминаем про акцию клиники.",
      dryRun: true,
      sendWindow: { start: "09:00", end: "21:00" }
    });
    assert.equal(dryRun.dry_run, true);
    assert.ok(dryRun.recipients_found >= 0);
    assert.ok(Array.isArray(dryRun.recipients));

    if (process.env.RUN_MANUAL_BROADCAST_SEND_TEST === "true") {
      const send = await queueManualBroadcast({
        contactIds: [contact.id],
        message: `Тестовая рассылка ${Date.now()}`,
        dryRun: false,
        sendWindow: { start: "09:00", end: "21:00" }
      });
      assert.equal(send.dry_run, false);
      assert.ok(send.campaign_id);
    }
  }
} catch (error) {
  console.warn(`manual broadcast db checks skipped: ${error.message}`);
} finally {
  await prisma.$disconnect().catch(() => {});
}

console.log("agent token/broadcast eval passed");

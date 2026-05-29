import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeStructuredAgentOutput,
  sanitizeReplyForUser
} from "../agent-api/src/replySanitizer.js";

const cases = JSON.parse(await readFile(new URL("./agent-safety-cases.json", import.meta.url), "utf8"));
const forbiddenPatterns = [
  /"reply"\s*:/iu,
  /"intent"\s*:/iu,
  /"action"\s*:/iu,
  /memory(?:_patch|_update)?/iu,
  /handoff/iu,
  /reasoning/iu,
  /tool/iu,
  /json/iu,
  /system/iu,
  /assistant/iu,
  /проверяю\s+данные/iu,
  /зафиксировал[аи]?/iu,
  /сохраняю/iu,
  /передаю\s+в\s+систем/iu
];

let passed = 0;

for (const testCase of cases) {
  const normalized = normalizeStructuredAgentOutput(testCase.raw, testCase.userMessage);
  const reply = normalized.reply;

  assert.equal(typeof reply, "string", `${testCase.name}: reply must be a string`);
  assert.ok(reply.trim(), `${testCase.name}: reply must not be empty`);
  assert.ok(!looksLikeJson(reply), `${testCase.name}: reply must not look like JSON`);

  for (const pattern of forbiddenPatterns) {
    assert.ok(!pattern.test(reply), `${testCase.name}: reply contains forbidden internal text: ${pattern}`);
  }

  assert.ok("memory_patch" in normalized, `${testCase.name}: memory_patch is missing`);
  assert.ok("memory_update" in normalized, `${testCase.name}: legacy memory_update is missing`);

  passed += 1;
}

assert.equal(
  sanitizeReplyForUser('{"reply":"Здравствуйте","intent":"booking"}', { userMessage: "Привет" }),
  "Здравствуйте",
  "raw structured JSON must be parsed and only reply should be returned"
);

const duplicateText = "Здравствуйте, хочу записаться";
assert.equal(
  normalizeComparable(duplicateText),
  normalizeComparable("  Здравствуйте,   хочу записаться "),
  "duplicate comparable text must normalize spacing and case"
);

console.log(`Agent safety eval passed: ${passed} cases`);

function looksLikeJson(text = "") {
  const trimmed = String(text || "").trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function normalizeComparable(value = "") {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/gu, " ").trim().toLowerCase();
}

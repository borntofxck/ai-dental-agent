import assert from "node:assert/strict";
import { MaxClient } from "../max-adapter/src/maxClient.js";

const client = new MaxClient();
let currentUrl = "https://web.max.ru/123";
let gotoCalls = 0;

client.startedAt = new Date("2026-06-04T00:00:00.000Z");
client.page = {
  url: () => currentUrl,
  title: async () => "MAX",
  goto: async (url) => {
    gotoCalls += 1;
    currentUrl = url;
  },
  waitForTimeout: async () => {}
};

assert.equal(client.getCurrentChatIdFromUrl(), "123");

const sameChat = await client.openChatByChatId("max_chat_123");
assert.equal(sameChat.opened, false);
assert.equal(sameChat.already_active, true);
assert.equal(gotoCalls, 0, "openChatByChatId must not call goto when chat is already active");

const otherChat = await client.openChatByChatId("max_chat_456");
assert.equal(otherChat.opened, true);
assert.equal(otherChat.already_active, false);
assert.equal(gotoCalls, 1, "openChatByChatId must call goto when another chat is active");
assert.equal(currentUrl, "https://web.max.ru/456");

console.log("max client eval passed");

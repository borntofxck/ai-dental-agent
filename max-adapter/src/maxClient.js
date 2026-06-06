import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { config } from "./config.js";

export class MaxClient {
  constructor() {
    this.context = null;
    this.page = null;
    this.startedAt = null;
  }

  async start() {
    if (this.context) return;

    this.context = await chromium.launchPersistentContext(config.userDataDir, {
      headless: config.headless,
      viewport: { width: 1366, height: 768 }
    });

    this.page = this.context.pages()[0] || await this.context.newPage();
    await this.page.goto(config.maxWebUrl, { waitUntil: "domcontentloaded" });
    this.startedAt = new Date();

    console.log(`MAX web opened at ${config.maxWebUrl}`);
    console.log(`MAX browser profile: ${config.userDataDir}`);
    console.log("Log in manually if MAX asks for authentication.");
  }

  ensureStarted() {
    if (!this.page) {
      throw new Error("MAX browser is not started. Run adapter with MAX_OPEN_BROWSER=true or call /max/start.");
    }
  }

  async status() {
    if (!this.page) {
      return {
        started: false,
        url: null,
        title: null,
        started_at: null,
        profile_dir: config.userDataDir
      };
    }

    return {
      started: true,
      url: this.page.url(),
      title: await this.page.title().catch(() => null),
      started_at: this.startedAt?.toISOString() || null,
      profile_dir: config.userDataDir
    };
  }

  async goto(url = config.maxWebUrl) {
    this.ensureStarted();
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    return this.status();
  }

  async inspect() {
    this.ensureStarted();

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const htmlPath = path.join(config.artifactsDir, `max-${timestamp}.html`);
    const screenshotPath = path.join(config.artifactsDir, `max-${timestamp}.png`);

    await this.page.screenshot({ path: screenshotPath, fullPage: true });
    await writeFile(htmlPath, await this.page.content(), "utf8");

    const locatorCounts = await this.getSelectorCounts();
    const pageSummary = await this.page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input, textarea, [contenteditable='true']")]
        .slice(0, 20)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute("type"),
          ariaLabel: element.getAttribute("aria-label"),
          placeholder: element.getAttribute("placeholder"),
          role: element.getAttribute("role"),
          text: element.textContent?.trim().slice(0, 80) || ""
        }));

      const buttons = [...document.querySelectorAll("button, [role='button']")]
        .slice(0, 30)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          ariaLabel: element.getAttribute("aria-label"),
          title: element.getAttribute("title"),
          text: element.textContent?.trim().slice(0, 80) || ""
        }));

      return { inputs, buttons };
    });

    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => null),
      html_path: htmlPath,
      screenshot_path: screenshotPath,
      selector_counts: locatorCounts,
      page_summary: pageSummary
    };
  }

  async screenshot() {
    this.ensureStarted();

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const screenshotPath = path.join(config.artifactsDir, `max-${timestamp}.png`);
    await this.page.screenshot({ path: screenshotPath, fullPage: true });

    return {
      path: screenshotPath,
      url: this.page.url(),
      title: await this.page.title().catch(() => null)
    };
  }

  async getSelectorCounts() {
    this.ensureStarted();

    const entries = Object.entries(config.selectors);
    const counts = {};

    for (const [name, selector] of entries) {
      counts[name] = selector ? await this.page.locator(selector).count().catch(() => -1) : null;
    }

    return counts;
  }

  async readVisibleMessages(limit = 20) {
    this.ensureStarted();

    if (!config.selectors.messageItem) {
      return {
        configured: false,
        messages: [],
        reason: "MAX_SELECTOR_MESSAGE_ITEM is not configured"
      };
    }

    const messages = await this.page.locator(config.selectors.messageItem).evaluateAll((nodes, max) => (
      nodes.slice(-max).map((node, index) => ({
        index,
        text: node.textContent?.trim() || ""
      }))
    ), limit);

    return {
      configured: true,
      messages
    };
  }

  async listChats() {
    this.ensureStarted();

    return this.page.locator("aside .item[data-index] button.cell").evaluateAll((nodes) => (
      nodes.map((node, index) => {
        const name = node.querySelector("h3")?.textContent?.trim().replace(/\s+/g, " ") || "";
        const text = node.textContent?.trim().replace(/\s+/g, " ") || "";
        const unread = node.querySelector("[aria-label*='новое сообщение'], [aria-label*='новых сообщений']")?.textContent?.trim() || "";
        const time = node.querySelector(".time")?.textContent?.trim() || "";

        return {
          index,
          name,
          text,
          unread,
          time,
          selected: node.className.includes("selected")
        };
      })
    ));
  }

  async openChat({ name, index } = {}) {
    this.ensureStarted();

    let chat;
    if (name) {
      chat = this.page.locator("aside .item[data-index] button.cell", { hasText: name }).first();
    } else if (Number.isInteger(index)) {
      chat = this.page.locator("aside .item[data-index] button.cell").nth(index);
    } else {
      chat = this.page.locator("aside .item[data-index] button.cell").first();
    }

    await chat.click();
    await this.page.waitForTimeout(800);

    return {
      opened: true,
      status: await this.status(),
      chats: await this.listChats()
    };
  }

  async openChatByChatId(chatId) {
    this.ensureStarted();

    const numericId = String(chatId || "").match(/\d+/)?.[0];
    if (!numericId) {
      throw new Error(`Cannot open MAX chat without numeric chat id: ${chatId}`);
    }

    const currentNumericId = this.getCurrentChatIdFromUrl();
    if (currentNumericId === numericId) {
      console.log(`MAX chat ${numericId} is already active; skipping page.goto`);
      return {
        opened: false,
        already_active: true,
        chat_id: chatId,
        status: await this.status()
      };
    }

    console.log(`Opening MAX chat ${numericId}; current chat is ${currentNumericId || "unknown"}`);
    await this.page.goto(`https://web.max.ru/${numericId}`, { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(500);

    return {
      opened: true,
      already_active: false,
      chat_id: chatId,
      status: await this.status()
    };
  }

  getCurrentChatIdFromUrl(url = null) {
    const currentUrl = String(url || this.page?.url?.() || "");
    return currentUrl.match(/(?:^|\/)(\d+)(?:[/?#].*)?$/u)?.[1] || null;
  }

  async readActiveChatMessages(limit = 20) {
    this.ensureStarted();

    const messages = await this.page.locator("main .history [role='listitem']").evaluateAll((nodes, max) => (
      nodes.slice(-max).map((node, index) => {
        const cleanText = (value = "") => String(value)
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const clone = node.cloneNode(true);
        clone.querySelectorAll([
          "time",
          ".time",
          "[class*='time']",
          "[aria-hidden='true']",
          "button",
          "svg"
        ].join(",")).forEach((element) => element.remove());

        const bubble = node.querySelector("[data-bubbles-variant]");
        const cleanBubble = clone.querySelector("[data-bubbles-variant]") || clone;
        const variant = bubble?.getAttribute("data-bubbles-variant") || null;
        const rawText = cleanText(node.innerText || node.textContent || "");
        let text = cleanText(cleanBubble.innerText || cleanBubble.textContent || "");

        if (!text) {
          text = cleanText(rawText.replace(/\s+\d{1,2}:\d{2}$/u, ""));
        }

        if (/^\d{1,2}:\d{2}$/u.test(text) && rawText === text) {
          text = "";
        }

        return {
          index,
          direction: variant,
          text,
          raw_text: rawText
        };
      })
    ), limit);

    return { messages };
  }

  async getActiveChatInfo() {
    this.ensureStarted();

    return this.page.evaluate(() => {
      const title = document.querySelector("main h2#main-header-title")?.textContent?.trim() || "";
      const profileButton = [...document.querySelectorAll("main button[aria-label^='Открыть профиль']")][0];
      const ariaLabel = profileButton?.getAttribute("aria-label") || "";
      const name = ariaLabel.replace(/^Открыть профиль\s*/i, "").trim();
      const subtitle = profileButton?.textContent?.trim().replace(/\s+/g, " ") || "";

      return { title, name, subtitle };
    });
  }

  async sendMessage(chatId, text) {
    this.ensureStarted();

    if (!config.selectors.messageInput) {
      console.log("Outgoing MAX message placeholder:", { chatId, text });
      return {
        sent: false,
        reason: "MAX_SELECTOR_MESSAGE_INPUT is not configured"
      };
    }

    const input = this.page.locator(config.selectors.messageInput).first();
    await input.click();
    await input.fill("").catch(async () => {
      await this.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
      await this.page.keyboard.press("Backspace").catch(() => {});
    });
    await input.fill(text).catch(async () => {
      await this.page.keyboard.type(text, { delay: 5 });
    });

    if (config.selectors.sendButton) {
      const sendButton = this.page.locator(config.selectors.sendButton).first();
      await sendButton.click({ timeout: 3000 }).catch(async () => {
        await input.press("Enter");
      });
    } else {
      await input.press("Enter");
    }

    const verification = await this.verifyMessageWasSent(text);

    return {
      sent: true,
      verified: verification.verified,
      chat_id: chatId || null,
      text
    };
  }

  async verifyMessageWasSent(text) {
    const expected = normalizeComparableText(text);
    const input = this.page.locator(config.selectors.messageInput).first();
    let composerText = "";

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.page.waitForTimeout(150);
      composerText = await input.evaluate((element) => (
        element.value || element.innerText || element.textContent || ""
      )).catch(() => "");

      if (!normalizeComparableText(composerText)) {
        return { verified: true, reason: "composer_cleared" };
      }
    }

    if (normalizeComparableText(composerText).includes(expected)) {
      throw new Error("MAX message was left in composer draft; send button probably did not submit it");
    }

    return { verified: false, reason: "composer_not_empty", composer_text: composerText };
  }

  async stop() {
    await this.context?.close();
    this.context = null;
    this.page = null;
    this.startedAt = null;
  }
}

function normalizeComparableText(value = "") {
  return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

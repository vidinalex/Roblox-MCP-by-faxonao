import { createLogger } from "../shared/logger.mjs";

function apiBase(token) {
  return `https://api.telegram.org/bot${token}`;
}

async function telegramRequest(token, method, body) {
  const response = await fetch(`${apiBase(token)}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.description || `Telegram request failed for ${method}`);
  }
  return payload.result;
}

async function sendTypingAction(token, chatId) {
  await telegramRequest(token, "sendChatAction", {
    chat_id: chatId,
    action: "typing"
  });
}

function normalizeUpdate(update) {
  const message = update.message || update.edited_message;
  if (!message?.text) {
    return null;
  }
  return {
    updateId: update.update_id,
    chatId: String(message.chat?.id || ""),
    messageId: String(message.message_id || ""),
    username: message.from?.username || "",
    text: message.text
  };
}

export class TelegramNotificationTransport {
  constructor(options) {
    this.token = options.token;
  }

  supports(notification) {
    return notification.channel === "telegram";
  }

  async send(notification) {
    await telegramRequest(this.token, "sendMessage", {
      chat_id: notification.chatId,
      text: notification.text
    });
  }
}

export class TelegramBotService {
  constructor(options) {
    this.config = options.config;
    this.store = options.store;
    this.router = options.router;
    this.messageHandler = options.messageHandler || null;
    this.logger = options.logger || createLogger("telegram");
    this.running = false;
  }

  supports(notification) {
    return notification.channel === "telegram";
  }

  async send(notification) {
    if (!this.config.enabled || !this.config.botToken) {
      return;
    }
    await telegramRequest(this.config.botToken, "sendMessage", {
      chat_id: notification.chatId,
      text: notification.text
    });
  }

  async start() {
    if (!this.config.enabled || !this.config.botToken) {
      this.logger.info("Telegram bot disabled in config.");
      return;
    }
    this.running = true;
    this.logger.info("Starting Telegram long polling.");
    while (this.running) {
      try {
        const offset = Number(this.store.getRuntimeMeta("telegram.offset", 0)) || 0;
        const updates = await telegramRequest(this.config.botToken, "getUpdates", {
          timeout: this.config.longPollTimeoutSec,
          offset,
          allowed_updates: ["message", "edited_message"]
        });
        for (const update of updates) {
          this.store.setRuntimeMeta("telegram.offset", Number(update.update_id) + 1);
          const event = normalizeUpdate(update);
          if (!event) {
            continue;
          }
          if (this.config.allowedChatIds.length > 0 && !this.config.allowedChatIds.includes(event.chatId)) {
            continue;
          }
          const startedAt = Date.now();
          let heartbeat = null;
          let chatEvent = null;
          try {
            chatEvent = this.store.createChatEvent({
              channel: "telegram",
              externalChatId: event.chatId,
              externalMessageId: event.messageId,
              status: "received",
              userText: event.text,
              meta: {
                username: event.username || "",
                updateId: event.updateId
              }
            });
            chatEvent = this.store.updateChatEvent(chatEvent.id, {
              status: "running"
            });
            await sendTypingAction(this.config.botToken, event.chatId).catch(() => {});
            heartbeat = setInterval(() => {
              void sendTypingAction(this.config.botToken, event.chatId).catch(() => {});
            }, 4000);

            const result = this.messageHandler
              ? await this.messageHandler.handleTelegramEvent(event)
              : await this.router.handleTelegramEvent(event);

            if (chatEvent) {
              this.store.updateChatEvent(chatEvent.id, {
                status: "completed",
                action: result?.action || "",
                taskId: result?.taskId || "",
                meta: {
                  username: event.username || "",
                  updateId: event.updateId,
                  durationMs: Date.now() - startedAt
                },
                completedAt: new Date().toISOString()
              });
            }
          } catch (error) {
            if (chatEvent) {
              this.store.updateChatEvent(chatEvent.id, {
                status: "failed",
                errorText: error instanceof Error ? error.message : String(error),
                meta: {
                  username: event.username || "",
                  updateId: event.updateId,
                  durationMs: Date.now() - startedAt
                },
                completedAt: new Date().toISOString()
              });
            }
            throw error;
          } finally {
            if (heartbeat) {
              clearInterval(heartbeat);
            }
          }
        }
      } catch (error) {
        this.logger.warn("Telegram polling iteration failed", error instanceof Error ? error.message : String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
    }
  }

  stop() {
    this.running = false;
  }
}

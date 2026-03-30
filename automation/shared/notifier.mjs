import { createLogger } from "./logger.mjs";

export class NotificationHub {
  constructor(options = {}) {
    this.logger = options.logger || createLogger("notify");
    this.transports = [];
  }

  registerTransport(transport) {
    this.transports.push(transport);
  }

  async send(notification) {
    for (const transport of this.transports) {
      if (typeof transport.supports === "function" && transport.supports(notification) === false) {
        continue;
      }
      try {
        await transport.send(notification);
      } catch (error) {
        this.logger.warn("Notification transport failed", {
          channel: notification.channel,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}

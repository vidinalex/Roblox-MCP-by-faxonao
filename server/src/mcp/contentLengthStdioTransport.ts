import process from "node:process";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

type OnMessage = (message: unknown) => void;
type OnError = (error: Error) => void;
type OnClose = () => void;

export class ContentLengthStdioTransport {
  onmessage?: OnMessage;
  onerror?: OnError;
  onclose?: OnClose;

  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private started = false;
  private buffer: Buffer = Buffer.alloc(0);

  constructor(stdin: NodeJS.ReadStream = process.stdin, stdout: NodeJS.WriteStream = process.stdout) {
    this.stdin = stdin;
    this.stdout = stdout;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("ContentLengthStdioTransport already started");
    }
    this.started = true;
    this.stdin.on("data", this.onData);
    this.stdin.on("error", this.onStdinError);
  }

  async close(): Promise<void> {
    this.stdin.off("data", this.onData);
    this.stdin.off("error", this.onStdinError);
    this.buffer = Buffer.alloc(0);
    this.onclose?.();
  }

  send(message: unknown): Promise<void> {
    return new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify(message), "utf8");
      const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
      const payload = Buffer.concat([header, body]);
      if (this.stdout.write(payload)) {
        resolve();
      } else {
        this.stdout.once("drain", resolve);
      }
    });
  }

  private readonly onStdinError = (error: Error): void => {
    this.onerror?.(error);
  };

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.consumeBuffer();
  };

  private consumeBuffer(): void {
    while (this.buffer.length > 0) {
      const separatorIndex = this.buffer.indexOf("\r\n\r\n");
      if (separatorIndex < 0) {
        // Fallback: newline-delimited JSON for local compatibility.
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) {
          return;
        }
        const line = this.buffer.toString("utf8", 0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.subarray(newline + 1);
        if (!line.trim()) {
          continue;
        }
        this.emitJson(line);
        continue;
      }

      const headerRaw = this.buffer.toString("utf8", 0, separatorIndex);
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headerRaw);
      if (!lengthMatch) {
        this.onerror?.(new Error("Missing Content-Length header"));
        this.buffer = this.buffer.subarray(separatorIndex + 4);
        continue;
      }
      const bodyLength = Number(lengthMatch[1]);
      const bodyStart = separatorIndex + 4;
      const totalLength = bodyStart + bodyLength;
      if (this.buffer.length < totalLength) {
        return;
      }
      const body = this.buffer.toString("utf8", bodyStart, totalLength);
      this.buffer = this.buffer.subarray(totalLength);
      this.emitJson(body);
    }
  }

  private emitJson(raw: string): void {
    try {
      const parsed = JSON.parse(raw);
      const valid = JSONRPCMessageSchema.parse(parsed);
      this.onmessage?.(valid);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.onerror?.(err);
    }
  }
}

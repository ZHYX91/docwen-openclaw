import { TextDecoder } from "node:util";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const HEADER_LIMIT_BYTES = 64;
const HEADER_PATTERN = /^Content-Length: ([1-9][0-9]*)\r\n\r\n$/;

export type JsonObject = Record<string, unknown>;

export function encodeMachineFrame(message: JsonObject): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_MESSAGE_BYTES) throw new Error("docwen_machine_frame_too_large");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export class MachineFrameDecoder {
  private header = Buffer.alloc(0);
  private body?: Buffer;
  private received = 0;

  feed(chunk: Buffer): JsonObject[] {
    const messages: JsonObject[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const remainingHeader = HEADER_LIMIT_BYTES - this.header.length;
        const prefix = chunk.subarray(offset, offset + remainingHeader);
        const header = this.header.length ? Buffer.concat([this.header, prefix]) : prefix;
        const headerEnd = header.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          if (header.length === HEADER_LIMIT_BYTES || header.indexOf("\n\n") >= 0)
            throw new Error("docwen_machine_invalid_frame_header");
          this.header = Buffer.from(header);
          break;
        }
        const headerLength = headerEnd + 4;
        const match = HEADER_PATTERN.exec(header.toString("latin1", 0, headerLength));
        if (!match?.[1]) throw new Error("docwen_machine_invalid_frame_header");
        const length = Number(match[1]);
        if (!Number.isSafeInteger(length) || length > MAX_MESSAGE_BYTES)
          throw new Error("docwen_machine_frame_too_large");
        offset += headerLength - this.header.length;
        this.header = Buffer.alloc(0);
        if (chunk.length - offset >= length) {
          messages.push(decodeBody(chunk.subarray(offset, offset + length)));
          offset += length;
          continue;
        }
        this.body = Buffer.allocUnsafe(length);
        this.received = 0;
      }
      const count = Math.min(this.body.length - this.received, chunk.length - offset);
      chunk.copy(this.body, this.received, offset, offset + count);
      this.received += count;
      offset += count;
      if (this.received === this.body.length) {
        messages.push(decodeBody(this.body));
        this.body = undefined;
      }
    }
    return messages;
  }

  finish(): void {
    if (this.header.length || this.body) throw new Error("docwen_machine_truncated_frame");
  }
}

function decodeBody(body: Buffer): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(UTF8_DECODER.decode(body));
  } catch {
    throw new Error("docwen_machine_invalid_frame_payload");
  }
  if (!isJsonObject(value)) throw new Error("docwen_machine_invalid_frame_payload");
  return value;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

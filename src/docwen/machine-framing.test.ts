import { describe, expect, it } from "vitest";

import { encodeMachineFrame, MachineFrameDecoder } from "./machine-framing.js";

describe("DocWen Machine Protocol framing", () => {
  it("rejects high-bit header aliases instead of masking them to ASCII", () => {
    const frame = Buffer.from("Content-Length: 2\r\n\r\n{}", "ascii");
    frame[0] = 0xc3; // ASCII decoding used to turn this byte into C.
    expect(() => new MachineFrameDecoder().feed(frame)).toThrow("docwen_machine_invalid_frame_header");
  });

  it.each([
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]),
  ])("rejects malformed UTF-8 and a leading BOM", (body) => {
    const frame = Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "ascii"), body]);
    expect(() => new MachineFrameDecoder().feed(frame)).toThrow("docwen_machine_invalid_frame_payload");
  });

  it("preserves multibyte characters split at every byte boundary", () => {
    const message = { text: "中文🙂" };
    const frame = encodeMachineFrame(message);
    const decoder = new MachineFrameDecoder();
    const decoded = [...frame].flatMap((byte) => decoder.feed(Buffer.from([byte])));
    decoder.finish();
    expect(decoded).toEqual([message]);
  });
  it("uses UTF-8 byte length and handles arbitrarily chunked frames", () => {
    const frame = encodeMachineFrame({ jsonrpc: "2.0", id: "中文", method: "capability/list", params: {} });
    const decoder = new MachineFrameDecoder();
    const messages = [...decoder.feed(frame.subarray(0, 7)), ...decoder.feed(frame.subarray(7))];
    decoder.finish();
    expect(messages).toEqual([{ jsonrpc: "2.0", id: "中文", method: "capability/list", params: {} }]);
  });

  it("decodes adjacent frames without losing boundaries", () => {
    const decoder = new MachineFrameDecoder();
    const messages = decoder.feed(
      Buffer.concat([encodeMachineFrame({ id: 1 }), encodeMachineFrame({ id: 2 })]),
    );
    expect(messages).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("rejects LF-only, extra headers, non-object payloads, and truncated bodies", () => {
    expect(() => new MachineFrameDecoder().feed(Buffer.from("Content-Length: 2\n\n{}"))).toThrow(
      "docwen_machine_invalid_frame_header",
    );
    expect(() => new MachineFrameDecoder().feed(Buffer.from("Content-Length: 2\r\nX: 1\r\n\r\n{}"))).toThrow(
      "docwen_machine_invalid_frame_header",
    );
    expect(() => new MachineFrameDecoder().feed(Buffer.from("Content-Length: 2\r\n\r\n[]"))).toThrow(
      "docwen_machine_invalid_frame_payload",
    );
    const decoder = new MachineFrameDecoder();
    decoder.feed(Buffer.from("Content-Length: 3\r\n\r\n{}"));
    expect(() => decoder.finish()).toThrow("docwen_machine_truncated_frame");
  });
});

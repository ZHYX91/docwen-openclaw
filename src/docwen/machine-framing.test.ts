import { describe, expect, it } from "vitest";

import { encodeMachineFrame, MachineFrameDecoder } from "./machine-framing.js";

describe("DocWen Machine Protocol framing", () => {
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

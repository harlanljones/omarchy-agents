import { describe, expect, test } from "bun:test";
import { redact } from "../src/server/redact";

describe("secret redaction", () => {
  test.each([
    ["Bearer abc.def_ghi-jkl", "Bearer [REDACTED]"],
    ["OPENAI_API_KEY=sk-live-abcdefghijklmnop", "OPENAI_API_KEY=[REDACTED]"],
    ["https://alice:hunter2@example.com/path", "https://alice:[REDACTED]@example.com/path"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature123", "[REDACTED JWT]"]
  ])("removes %s", (input, expected) => expect(redact(input)).toContain(expected));

  test("omits base64 payloads", () => expect(redact("A".repeat(300))).toBe("[BINARY PAYLOAD OMITTED]"));
});

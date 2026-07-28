import { describe, expect, it } from "vitest";
import { linkifyCitations } from "./citations";

describe("linkifyCitations", () => {
  it("turns a bare citation marker into a link scoped to the message id", () => {
    const result = linkifyCitations("Refunds take 5 days [2].", "msg-1");
    expect(result).toBe(
      'Refunds take 5 days <sup><a href="#source-msg-1-1" class="citation-link">[2]</a></sup>.',
    );
  });

  it("resolves the link index 1-indexed from the marker down to 0-indexed for the DOM id", () => {
    const result = linkifyCitations("[1]", "msg-1");
    expect(result).toContain('href="#source-msg-1-0"');
  });

  it("linkifies multiple distinct markers in the same text", () => {
    const result = linkifyCitations("First [1], second [3].", "msg-1");
    expect(result).toContain('href="#source-msg-1-0"');
    expect(result).toContain('href="#source-msg-1-2"');
  });

  it("does not touch real markdown links, even ones with a bracketed number as their text", () => {
    const result = linkifyCitations("See [1](https://example.com) for details.", "msg-1");
    expect(result).toBe("See [1](https://example.com) for details.");
  });

  it("leaves text with no citation markers unchanged", () => {
    const result = linkifyCitations("Hello, how can I help?", "msg-1");
    expect(result).toBe("Hello, how can I help?");
  });
});

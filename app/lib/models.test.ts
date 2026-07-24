import { describe, it, expect } from "vitest";
import { parseModelList } from "./models";

describe("parseModelList", () => {
  it("parses id:name pairs separated by commas", () => {
    expect(
      parseModelList("gpt-4o-mini:GPT-4o Mini,gpt-4o:GPT-4o"),
    ).toEqual([
      { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      { id: "gpt-4o", name: "GPT-4o" },
    ]);
  });

  it("trims whitespace around entries", () => {
    expect(parseModelList(" gpt-4o : GPT-4o ")).toEqual([
      { id: "gpt-4o", name: "GPT-4o" },
    ]);
  });

  it("joins a name containing a colon back together", () => {
    expect(parseModelList("openrouter/anthropic/claude-sonnet-4-6:Claude: Sonnet 4.6")).toEqual([
      { id: "openrouter/anthropic/claude-sonnet-4-6", name: "Claude: Sonnet 4.6" },
    ]);
  });
});

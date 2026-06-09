import { describe, expect, test } from "bun:test";
import { parseFlags } from "./mem";

describe("parseFlags", () => {
  test("value flags capture the following token", () => {
    const f = parseFlags(["--kind", "user", "--source", "maor", "--content", "hello world"]);
    expect(f.kind).toBe("user");
    expect(f.source).toBe("maor");
    expect(f.content).toBe("hello world");
  });

  test("a value starting with -- is still captured as the value (not misread as a flag)", () => {
    const f = parseFlags(["--content", "--weird"]);
    expect(f.content).toBe("--weird");
    expect(f.weird).toBeUndefined();
  });

  test("--raw is a boolean flag and consumes no value", () => {
    const f = parseFlags(["5", "--raw"]);
    expect(f.raw).toBe(true);
    expect(f._).toEqual(["5"]);
  });

  test("bare args collect into _ in order", () => {
    const f = parseFlags(["search", "two", "words"]);
    expect(f._).toEqual(["search", "two", "words"]);
  });

  test("a value-flag with no following token becomes boolean true", () => {
    const f = parseFlags(["--content"]);
    expect(f.content).toBe(true);
  });
});

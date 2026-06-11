import { test, expect } from "bun:test";
import { buildReviewPrompt, reviewSpawnArgs, shouldReview, REVIEW_ALLOWED_TOOLS } from "./review.ts";

test("buildReviewPrompt embeds the rules and the transcript in order", () => {
  const p = buildReviewPrompt([
    { role: "user", content: "אני אלרגי לבוטנים" },
    { role: "assistant", content: "רשמתי" },
  ]);
  expect(p).toContain("mem.ts add");
  expect(p).toContain("skill.ts");
  expect(p).toContain("--source derived");
  expect(p.indexOf("[user] אני אלרגי לבוטנים")).toBeLessThan(p.indexOf("[assistant] רשמתי"));
  expect(p).toContain("PATCH an existing");
});

test("reviewSpawnArgs whitelists exactly mem.ts and skill.ts, cheap model, no skip-permissions", () => {
  const args = reviewSpawnArgs();
  expect(args).toContain("--allowedTools");
  for (const t of REVIEW_ALLOWED_TOOLS) expect(args).toContain(t);
  expect(args).toContain("haiku");
  expect(args).not.toContain("--dangerously-skip-permissions"); // whitelist must bind
});

test("shouldReview gates by per-chat cooldown", () => {
  const state = new Map<number, number>();
  expect(shouldReview(1, 1000, state)).toBe(true);
  expect(shouldReview(1, 1000 + 899, state)).toBe(false); // inside 15 min
  expect(shouldReview(2, 1000 + 10, state)).toBe(true); // other chat independent
  expect(shouldReview(1, 1000 + 900, state)).toBe(true); // cooldown elapsed
});

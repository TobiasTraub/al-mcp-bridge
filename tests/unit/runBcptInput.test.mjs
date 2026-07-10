import { test } from "node:test";
import assert from "node:assert/strict";
import { RunBcptInput } from "../../dist/tools/runBcpt.js";

test("RunBcptInput requires suiteCode and accepts a minimal valid input", () => {
  assert.equal(RunBcptInput.safeParse({}).success, false);
  assert.equal(RunBcptInput.safeParse({ suiteCode: "SALES" }).success, true);
});

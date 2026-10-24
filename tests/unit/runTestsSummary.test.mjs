import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../../dist/tools/runTests.js";

const row = (codeunitId, methodName, status, output = "") => ({
  codeunitId,
  methodName,
  status,
  output,
  durationMs: 1,
});

test("codeunit summary rows are not counted as tests", () => {
  const r = summarize(
    1,
    [
      row(1, "A", "Passed"),
      row(1, "", "Passed"),
      row(2, "B", "Failed", "boom"),
      row(2, "C", "Passed"),
      row(2, "", "Failed", "boom"),
    ],
    [],
    5,
  );
  assert.equal(r.total, 3);
  assert.equal(r.passed, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.succeeded, false);
  assert.deepEqual(
    r.codeunits.map((c) => [c.codeunitId, c.status]),
    [
      [1, "Passed"],
      [2, "Failed"],
    ],
  );
  assert.deepEqual(r.warnings, []);
});

test("a codeunit failing outside its methods fails the run", () => {
  const r = summarize(1, [row(1, "A", "Passed"), row(1, "", "Failed", "OnRun error")], [], 5);
  assert.equal(r.failed, 0);
  assert.equal(r.succeeded, false);
  assert.match(r.warnings[0], /Codeunit 1 failed outside its test methods: OnRun error/);
  assert.match(r.message, /1 codeunit\(s\) failed outside/);
});

test("only codeunit rows means no test results", () => {
  const r = summarize(1, [row(1, "", "Passed")], [], 5);
  assert.equal(r.total, 0);
  assert.equal(r.succeeded, false);
});

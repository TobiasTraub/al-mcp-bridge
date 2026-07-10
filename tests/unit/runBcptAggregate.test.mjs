import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "../../dist/tools/runBcpt.js";

const e = (lineNo, durationMs, sql) => ({
  bcptCode: "S", bcptLineNo: lineNo, codeunitId: 1, codeunitName: "CU",
  durationMs, noOfSqlStatements: sql, operation: "OnRun",
  status: "Success", startTime: "2026-07-10T10:00:00Z",
});

test("aggregate computes per-line count/min/max/avg and percentiles", () => {
  const rows = [10, 20, 30, 40, 100].map((d, i) => e(10000, d, i));
  const r = aggregate("S", rows, 5000, []);
  assert.equal(r.succeeded, true);
  assert.equal(r.lines.length, 1);
  const l = r.lines[0];
  assert.equal(l.operations, 5);
  assert.equal(l.durationMinMs, 10);
  assert.equal(l.durationMaxMs, 100);
  assert.equal(l.durationAvgMs, 40);
  assert.equal(l.durationP50Ms, 30);
  assert.equal(l.durationP90Ms, 100);
  assert.equal(l.durationP95Ms, 100);
  assert.equal(l.sqlStatementsAvg, 2); // sql values 0,1,2,3,4 -> avg 2
  assert.equal(r.queryMs, 5000);
});

test("aggregate flags failure on non-Success status and empty runs", () => {
  assert.equal(aggregate("S", [], 10, []).succeeded, false);
  const bad = [{ ...e(1, 5, 0), status: "Failure" }];
  assert.equal(aggregate("S", bad, 10, []).succeeded, false);
});

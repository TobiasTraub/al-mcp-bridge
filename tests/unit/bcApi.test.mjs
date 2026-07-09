import { test } from "node:test";
import assert from "node:assert/strict";
import { getBcptLogEntries } from "../../dist/bc/bcApi.js";

test("getBcptLogEntries calls the performancToolkit v1.0 endpoint and maps rows", async () => {
  let calledUrl = "";
  const fetchStub = async (url) => {
    calledUrl = String(url);
    return { ok: true, json: async () => ({ value: [{
      bcptCode: "SALES", bcptLineNo: 10000, codeunitID: 130001,
      codeunitName: "Post Sales", durationMin: 12, noOfSQLStmts: 4,
      operation: "OnRun", status: "Success", startTime: "2026-07-10T10:00:00Z",
    }] }) };
  };
  const rows = await getBcptLogEntries(
    new URL("https://bc.local"), "BC", "default", "cid", "SALES",
    "2026-07-10T09:00:00Z", { username: "u", password: "p" }, false, fetchStub);
  assert.match(calledUrl, /\/BC\/api\/microsoft\/performancToolkit\/v1\.0\/companies\(cid\)\/bcptLogEntries/);
  assert.match(decodeURIComponent(calledUrl), /bcptCode eq 'SALES'/);
  assert.deepEqual(
    { lineNo: rows[0].bcptLineNo, dur: rows[0].durationMs, sql: rows[0].noOfSqlStatements },
    { lineNo: 10000, dur: 12, sql: 4 });
});

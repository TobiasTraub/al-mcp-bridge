import { test } from "node:test";
import assert from "node:assert/strict";
import { getBcptLogEntries, getCompanyId } from "../../dist/bc/bcApi.js";

test("getBcptLogEntries calls the performancToolkit v1.0 endpoint and maps rows", async () => {
  let calledUrl = "";
  const fetchStub = async (url) => {
    calledUrl = String(url);
    return { ok: true, json: async () => ({ value: [{
      bcptCode: "SALES", lineNumber: 10000, codeunitID: 130001,
      codeunitName: "Post Sales", durationMin: 12, numberOfSQLStmts: 4,
      operation: "OnRun", status: "Success", startTime: "2026-07-10T10:00:00Z",
    }] }) };
  };
  const rows = await getBcptLogEntries(
    new URL("https://bc.local"), "BC", "default", "cid", "SALES",
    "2026-07-10T09:00:00Z", { username: "u", password: "p" }, false, fetchStub);
  assert.match(calledUrl, /\/BC\/api\/microsoft\/performancToolkit\/v1\.0\/companies\(cid\)\/bcptLogEntries/);
  assert.match(decodeURIComponent(calledUrl), /bcptCode eq 'SALES'/);
  assert.deepEqual(
    { lineNo: rows[0].bcptLineNo, cu: rows[0].codeunitId, dur: rows[0].durationMs, sql: rows[0].noOfSqlStatements },
    { lineNo: 10000, cu: 130001, dur: 12, sql: 4 });
});

test("getCompanyId calls the v2.0 companies endpoint with a name filter and returns the id", async () => {
  let calledUrl = "";
  const fetchStub = async (url) => {
    calledUrl = String(url);
    return { ok: true, json: async () => ({ value: [
      { id: "abc-123", name: "CRONUS International Ltd." },
    ] }) };
  };
  const id = await getCompanyId(
    new URL("https://bc.local"), "BC", "default", "CRONUS International Ltd.",
    { username: "u", password: "p" }, false, fetchStub);
  assert.match(calledUrl, /\/BC\/api\/v2\.0\/companies/);
  assert.match(decodeURIComponent(calledUrl), /\$filter=name eq 'CRONUS International Ltd\.'/);
  assert.equal(id, "abc-123");
});

test("getCompanyId throws when no company matches the name", async () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ value: [] }) });
  await assert.rejects(
    getCompanyId(
      new URL("https://bc.local"), "BC", "default", "Nope Ltd.",
      { username: "u", password: "p" }, false, fetchStub),
    /No company id for 'Nope Ltd\.'/);
});

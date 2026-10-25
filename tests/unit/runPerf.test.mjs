import { test } from "node:test";
import assert from "node:assert/strict";
import { callPerfProcedure, ensureOnPremOptIn } from "../../dist/bc/perfToolkit.js";
import { buildParams, summarize } from "../../dist/tools/runPerf.js";
import { deriveApiInstance } from "../../dist/bc/connection.js";

const creds = { username: "u", password: "p" };

test("callPerfProcedure posts the parameters to PerfToolkitSOC_<Procedure> and parses the value document", async () => {
  let calledUrl = ""; let init;
  const fetchStub = async (url, i) => {
    calledUrl = String(url); init = i;
    return { ok: true, status: 200, json: async () => ({ value: JSON.stringify({ schema: "socitas.perf.run/1", status: "Passed" }) }) };
  };
  const doc = await callPerfProcedure(new URL("https://bc.local:56565"), "c1-rest", undefined, "CRONUS AG",
    "RunScenario", { scenarioName: "Smoke", iterations: 5 }, creds, false, fetchStub);
  assert.match(calledUrl, /\/c1-rest\/ODataV4\/PerfToolkitSOC_RunScenario\?company=CRONUS(\+|%20)AG/);
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body), { scenarioName: "Smoke", iterations: 5 });
  assert.equal(doc.status, "Passed");
});

test("callPerfProcedure surfaces the OData error message on a non-OK response", async () => {
  const fetchStub = async () => ({ ok: false, status: 404, json: async () => ({ error: { message: "Resource not found for the segment 'PerfToolkitSOC_RunScenario'." } }) });
  await assert.rejects(
    callPerfProcedure(new URL("https://bc.local"), "c1-rest", undefined, "X", "RunScenario", {}, creds, false, fetchStub),
    /404.*Resource not found/);
});

test("callPerfProcedure rejects a response without a value document", async () => {
  const fetchStub = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await assert.rejects(
    callPerfProcedure(new URL("https://bc.local"), "c1-rest", undefined, "X", "ListScenarios", {}, creds, false, fetchStub),
    /returned no document/);
});

test("ensureOnPremOptIn does not PATCH when on-prem runs are already allowed", async () => {
  const calls = [];
  const fetchStub = async (url, i) => {
    calls.push(i.method);
    return { ok: true, status: 200, json: async () => ({ value: [{ id: "s1", allowOnPremRuns: true }] }) };
  };
  const r = await ensureOnPremOptIn(new URL("https://bc.local"), "c1-rest", undefined, "cid", creds, false, fetchStub);
  assert.deepEqual(r, { wasAllowed: true, allowed: true });
  assert.deepEqual(calls, ["GET"]);
});

test("ensureOnPremOptIn PATCHes allowOnPremRuns with If-Match when it is off", async () => {
  const calls = [];
  const fetchStub = async (url, i) => {
    calls.push({ url: String(url), method: i.method, headers: i.headers, body: i.body });
    if (i.method === "GET") return { ok: true, status: 200, json: async () => ({ value: [{ id: "s1", allowOnPremRuns: false }] }) };
    return { ok: true, status: 200, json: async () => ({ id: "s1", allowOnPremRuns: true }) };
  };
  const r = await ensureOnPremOptIn(new URL("https://bc.local"), "c1-rest", undefined, "cid", creds, false, fetchStub);
  assert.deepEqual(r, { wasAllowed: false, allowed: true });
  assert.equal(calls[1].method, "PATCH");
  assert.match(calls[1].url, /\/c1-rest\/api\/socitas\/performance\/v1\.0\/companies\(cid\)\/perfSetups\(s1\)/);
  assert.equal(calls[1].headers["If-Match"], "*");
  assert.deepEqual(JSON.parse(calls[1].body), { allowOnPremRuns: true });
});

test("buildParams maps run inputs to the exact web-service parameter names with defaults", () => {
  assert.deepEqual(buildParams({ scenario: "Smoke" }),
    { scenarioName: "Smoke", iterations: 0, label: "", runContext: "", markAsBaseline: false, tolerancePct: 0 });
  assert.deepEqual(buildParams({ action: "compare", entryNo: 7 }), { entryNo: 7, baseEntryNo: 0 });
  assert.throws(() => buildParams({ action: "run" }), /needs 'scenario'/);
  assert.throws(() => buildParams({ action: "setBaseline" }), /needs 'entryNo'/);
});

test("summarize passes the gate only for status Passed", () => {
  const passed = summarize("run", { status: "Passed", entryNo: 3, scenario: "Smoke", stats: { sqlStatements: { median: 5, max: 5 } }, baseline: null }, []);
  assert.equal(passed.gate, "pass");
  assert.equal(passed.succeeded, true);
  for (const status of ["Regressed", "BudgetExceeded", "Failed"]) {
    const r = summarize("run", { status, error: { message: "x" } }, []);
    assert.equal(r.gate, "fail", status);
    assert.equal(r.succeeded, true, `${status} is a measured result, not a tool failure`);
  }
  const refused = summarize("run", { status: "Refused", error: { message: "on-prem needs opt-in" } }, []);
  assert.equal(refused.gate, "fail");
  assert.equal(refused.succeeded, false);
  assert.match(refused.message, /on-prem needs opt-in/);
  const invalid = summarize("run", { status: "InvalidInput", scenario: "X", error: { message: "Scenario X is not installed." } }, []);
  assert.doesNotMatch(invalid.message, /\.\.$/);
});

test("deriveApiInstance maps -dev to -rest and honours the override", () => {
  assert.equal(deriveApiInstance("ai-trto-28-5-dev", {}), "ai-trto-28-5-rest");
  assert.equal(deriveApiInstance("BC", {}), "BC");
  assert.equal(deriveApiInstance("x-dev", { BC_API_INSTANCE: "custom" }), "custom");
  assert.equal(deriveApiInstance("x-dev", { BC_BCPT_API_INSTANCE: "legacy" }), "legacy");
});

# `al_run_bcpt` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an MCP tool `al_run_bcpt` that runs a Business Central Performance Toolkit (BCPT) suite headlessly against an on-prem BC 28.3 service tier and returns per-line duration/SQL percentiles.

**Architecture:** Start the suite by automating BCPT test-runner **page 149002** over the **`/cs/` client-service endpoint** (a TS port of `ClientContext.ps1`'s interaction sequence); read results over the **shipped `bcptLogEntries` API**; aggregate percentiles client-side. Network-only — no Docker host, no BcContainerHelper, no custom AL. Connection/auth is reused from `runTests.ts`, lifted into a shared `src/bc/` module.

**Tech Stack:** TypeScript (ESM, Node 20), `@modelcontextprotocol/sdk`, `zod`, global `fetch` for the API, `ws` for the `/cs/` transport. Tests: **Node's built-in `node --test`** (NOT vitest — confirmed in Task 0).

## Testing Conventions (authoritative — overrides any per-task snippet)

The repo uses Node's built-in test runner, not vitest. Every test task follows this exactly:

- Test files are **`.mjs`** under **`tests/unit/`** (e.g. `tests/unit/bcApi.test.mjs`). Pattern from `tests/unit/autodetect.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { thing } from "../../dist/<path>.js";   // import COMPILED output, not src

test("describes the behavior", () => {
  assert.equal(actual, expected);
});
```

- **Tests import from `dist/`**, so the source must be compiled first. `pretest:unit` already runs `npm run build`.
- **Run a single unit file:** `npm run build && node --test tests/unit/<name>.test.mjs`
- **Run all unit tests:** `npm run test:unit`
- **No mocking library.** Do not use `vi.*`/`jest.*`. For code that calls `fetch`, use **dependency injection**: the function takes an optional `fetchFn = fetch` last parameter; tests pass a stub `async (url, opts) => ({ ok: true, json: async () => (...) })`. Use `node:test`'s `mock` only if injection is impossible.
- Assertions use `node:assert/strict` (`assert.equal`, `assert.deepEqual`, `assert.match`, `assert.rejects`).

## Global Constraints

- **Connection model:** on-prem + `UserPassword`/Basic auth only; read server/instance/tenant/port from `.vscode/launch.json`; credentials from `BC_USER`/`BC_PASSWORD` or `~/.config/al-mcp-bridge/credentials.json` (mode 0600). Same as `al_run_tests`.
- **Security:** every error string passes through `redact()` before leaving a module; passwords never logged or returned. Plain-HTTP launch URL → "credentials travel unencrypted" warning.
- **No new runtime deps on BcContainerHelper / Windows / Docker host.** Pure TS, Linux-capable.
- **No custom AL.** Target BC ≥ 20 ships `bcptLogEntries`/`bcptSuites`; 28.3 confirmed.
- **Tool result serialization:** compact JSON via the existing `json()` helper in `register.ts`.
- **Concurrency:** serialize runs per `{origin}|{instance}|{tenant}` with the existing `withHubLock`.

---

## File Structure

- `src/bc/connection.ts` — **new**; shared helpers lifted from `runTests.ts` (`readLaunchConfig`, `LaunchConfig`, `normalizeServerUrl`, `loadCredentials`, `Credentials`, `redact`, `withHubLock`, `BcConnectionError`).
- `src/bc/bcApi.ts` — **new**; Performance Toolkit API client (`getCompanyId`, `getBcptLogEntries`).
- `src/bc/clientSession.ts` — **new**; minimal `/cs/` client-service protocol client (built to the shape discovered in Task 1).
- `src/tools/runBcpt.ts` — **new**; `createRunBcpt`, input schema, orchestration, aggregation.
- `src/tools/runTests.ts` — **modify**; import the shared helpers from `src/bc/connection.ts` instead of owning them.
- `src/tools/register.ts` — **modify**; register `al_run_bcpt`.
- `tests/bcApi.test.ts`, `tests/runBcptAggregate.test.ts`, `tests/runBcptInput.test.ts` — **new**.
- `.dev/cs-protocol-notes.md` — **new** (Task 1 output); captured `/cs/` wire format.
- `spike/cs-probe.mts` — **new** (Task 1); throwaway probe, deleted or archived after.

---

## Task 0: Confirm toolchain & baseline green

**Files:** none (inspection only)

- [ ] **Step 1:** Read `package.json` scripts and devDependencies. Confirm the test runner (expected `vitest`) and build (`tsc`) commands. If it is not `vitest`, substitute the real runner in every `Run:` command below.

Run: `cat package.json`
Expected: a `test` script and a `build` script; note their exact commands.

- [ ] **Step 2:** Install and run the existing suite to establish a green baseline.

Run: `npm ci && npm test`
Expected: all existing tests PASS. If red, stop and fix the environment before continuing.

- [ ] **Step 3:** Confirm `ws` (WebSocket client) is available or add it.

Run: `node -e "require.resolve('ws')" && echo present || npm i ws @types/ws`
Expected: `present`, or a clean install.

---

## Task 1: SPIKE — `/cs/` client-service handshake (make-or-break)

> This is a **research spike**, not TDD. Its deliverable is *captured knowledge* + a go/no-go decision. It needs a live BC 28.3 container reachable over the network, `BC_USER`/`BC_PASSWORD`, and one **already-defined BCPT suite** (note its code). Do NOT proceed to Task 6 until this gate passes.

**Files:**
- Create: `spike/cs-probe.mts` (throwaway)
- Create: `.dev/cs-protocol-notes.md` (durable output)

**Interfaces:**
- Produces (for Task 6): documented `OpenSession` handshake, the `InvokeInteraction` request/response envelope, and how form/control state is represented — written to `.dev/cs-protocol-notes.md`.

- [ ] **Step 1:** Extract the reference. Obtain Microsoft's `RunBCPTTests.ps1` (in a container at `C:\Applications\testframework\TestRunner\`, or from the BC artifacts / a colleague with host access) and read it alongside the local `ClientContext.ps1` at `C:/Users/trto/Documents/PowerShell/Modules/BcContainerHelper/6.1.10/AppHandling/ClientContext.ps1`. Record: the exact page it opens (expect 149002), the control it sets the suite code on, the action it invokes, and how it detects completion.

- [ ] **Step 2:** Capture the wire protocol. Point a proxy (e.g. mitmproxy, or Chrome DevTools against the web client) at `{PublicWebBaseUrl}/cs/` while manually opening page 149002 and clicking Start in the browser. Save representative `OpenSession`, `OpenForm`, `SaveValue`, `InvokeAction`, and poll frames to `.dev/cs-protocol-notes.md`. Cross-check against the Frycos protocol write-up (JSON-RPC 2.0: `Invoke`, `openFormIds`, `sessionId`, `sequenceNo`, `interactionsToInvoke`).

- [ ] **Step 3:** Minimal TS probe. Write `spike/cs-probe.mts` that, using `BC_USER`/`BC_PASSWORD` + a URL from argv, performs only `OpenSession` then `OpenForm(149002)` against `{webBaseUrl}/cs/?tenant=<t>&company=<c>`, and prints the returned control tree. Reuse the Basic-auth header construction from `runTests.ts`.

Run: `BC_USER=... BC_PASSWORD=... node --loader ts-node/esm spike/cs-probe.mts "https://<host>/<instance>" <tenant> "<company>"`
Expected: a printed control/form tree for page 149002 (proves session + form open work).

- [ ] **Step 4: DECISION GATE.** If Step 3 prints the form's controls → **GO**: record the envelope shapes in `.dev/cs-protocol-notes.md` and continue to Tasks 2–5 (independent) and then Task 6. If the handshake cannot be made to work within the timebox → **STOP**: report to the user with the specific blocker; reconsider (e.g. obtaining container-host access to run `RunBCPTTests.ps1` directly). Do not write Task 6 blind.

- [ ] **Step 5: Commit the notes** (not the spike secrets).

```bash
git add .dev/cs-protocol-notes.md
git commit -m "docs: capture /cs/ client-service protocol for al_run_bcpt spike"
```

---

## Task 2: Lift shared connection helpers into `src/bc/connection.ts`

**Files:**
- Create: `src/bc/connection.ts`
- Modify: `src/tools/runTests.ts` (remove the lifted helpers; import them)
- Test: existing `tests/*runTests*` (guards the move)

**Interfaces:**
- Produces: `readLaunchConfig(projectPath, name?) : LaunchConfig`, `LaunchConfig`, `normalizeServerUrl(server, port?) : URL`, `loadCredentials(origin, instance) : Credentials`, `Credentials`, `redact(s) : string`, `withHubLock<T>(key, fn) : Promise<T>`, `class BcConnectionError`.

- [ ] **Step 1:** Create `src/bc/connection.ts` and **move** (cut, not copy) the following from `runTests.ts` verbatim: `BcConnectionError`, `hubLocks`/`withHubLock`, `readLaunchConfig` + `LaunchConfig` + `readString` + `stripJsonComments`, `normalizeServerUrl`, `loadCredentials` + `Credentials`, `redact`, `describeError`. Add `export` to each symbol other tasks consume.

- [ ] **Step 2:** In `runTests.ts`, delete the moved definitions and add at the top:

```ts
import {
  BcConnectionError, Credentials, LaunchConfig, loadCredentials,
  normalizeServerUrl, readLaunchConfig, redact, withHubLock,
} from "../bc/connection.js";
```

- [ ] **Step 3: Add a characterization test** for two pure moved helpers (there are no existing `runTests` unit tests, so `tsc` + this new test are the guard). Create `tests/unit/connection.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, normalizeServerUrl } from "../../dist/bc/connection.js";

test("redact removes Basic auth tokens and password fields", () => {
  assert.match(redact("Authorization: Basic YWJjOjEyMw=="), /Basic \[redacted\]/);
  assert.equal(redact('{"password":"hunter2"}'), '{"password":"[redacted]"}');
});

test("normalizeServerUrl adds https and applies the port", () => {
  const u = normalizeServerUrl("bc.local", 7049);
  assert.equal(u.protocol, "https:");
  assert.equal(u.port, "7049");
});
```

- [ ] **Step 4: Build, then run the new test.**

Run: `npm run build && node --test tests/unit/connection.test.mjs`
Expected: clean `tsc` exit 0; both tests PASS. (A `tsc` error means a dangling reference from the move — fix it.)

- [ ] **Step 5: Commit.**

```bash
git add src/bc/connection.ts src/tools/runTests.ts tests/unit/connection.test.mjs
git commit -m "refactor: lift shared BC connection helpers into src/bc/connection.ts"
```

---

## Task 3: `bcApi.ts` — read BCPT log entries over the shipped API

**Files:**
- Create: `src/bc/bcApi.ts`
- Test: `tests/bcApi.test.ts`

**Interfaces:**
- Consumes: `Credentials`, `redact` from `src/bc/connection.ts`.
- Produces:
  - `type RawLogEntry = { bcptCode: string; bcptLineNo: number; codeunitId: number; codeunitName: string; durationMs: number; noOfSqlStatements: number; operation: string; status: string; startTime: string; }`
  - `getCompanyId(baseUrl: URL, instance: string, tenant: string | undefined, companyName: string, creds: Credentials, allowInvalidCert: boolean) : Promise<string>`
  - `getBcptLogEntries(baseUrl: URL, instance: string, tenant: string | undefined, companyId: string, suiteCode: string, sinceIso: string, creds: Credentials, allowInvalidCert: boolean) : Promise<RawLogEntry[]>`

- [ ] **Step 1: Write the failing test.** Mock `fetch` and assert URL + mapping.

```ts
import { describe, it, expect, vi } from "vitest";
import { getBcptLogEntries } from "../src/bc/bcApi.js";

describe("getBcptLogEntries", () => {
  it("calls the performancToolkit v1.0 endpoint and maps rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ value: [{
        bcptCode: "SALES", bcptLineNo: 10000, codeunitID: 130001,
        codeunitName: "Post Sales", durationMin: 12, noOfSQLStmts: 4,
        operation: "OnRun", status: "Success", startTime: "2026-07-10T10:00:00Z",
      }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const rows = await getBcptLogEntries(
      new URL("https://bc.local"), "BC", "default", "cid", "SALES",
      "2026-07-10T09:00:00Z", { username: "u", password: "p" }, false);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/BC/api/microsoft/performancToolkit/v1.0/companies(cid)/bcptLogEntries");
    expect(url).toContain("bcptCode eq 'SALES'");
    expect(rows[0]).toMatchObject({ bcptLineNo: 10000, durationMs: 12, noOfSqlStatements: 4 });
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run tests/bcApi.test.ts`
Expected: FAIL — `getBcptLogEntries` not found.

- [ ] **Step 3: Implement `src/bc/bcApi.ts`.** Confirm the exact JSON field names against your live API response captured in Task 1 (BC API pages camel-case the field captions; adjust the mapping if the probe shows different keys).

```ts
import { Credentials, redact } from "./connection.js";

export type RawLogEntry = {
  bcptCode: string; bcptLineNo: number; codeunitId: number; codeunitName: string;
  durationMs: number; noOfSqlStatements: number; operation: string;
  status: string; startTime: string;
};

function auth(creds: Credentials): string {
  return "Basic " + Buffer.from(`${creds.username}:${creds.password}`, "utf8").toString("base64");
}

function apiBase(baseUrl: URL, instance: string, tenant?: string): string {
  const u = new URL(baseUrl.toString());
  u.pathname = `/${instance}/api/microsoft/performancToolkit/v1.0`;
  if (tenant) u.searchParams.set("tenant", tenant);
  return u.toString();
}

async function getJson(url: string, creds: Credentials, allowInvalidCert: boolean): Promise<any> {
  if (allowInvalidCert) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const res = await fetch(url, { headers: { Authorization: auth(creds), Accept: "application/json" } });
  if (!res.ok) throw new Error(redact(`BCPT API ${res.status} for ${url.split("?")[0]}`));
  return res.json();
}

export async function getCompanyId(
  baseUrl: URL, instance: string, tenant: string | undefined,
  companyName: string, creds: Credentials, allowInvalidCert: boolean,
): Promise<string> {
  const u = new URL(baseUrl.toString());
  u.pathname = `/${instance}/api/v2.0/companies`;
  if (tenant) u.searchParams.set("tenant", tenant);
  u.searchParams.set("$filter", `name eq '${companyName.replace(/'/g, "''")}'`);
  const data = await getJson(u.toString(), creds, allowInvalidCert);
  const first = data?.value?.[0];
  if (!first?.id) throw new Error(`No company id for '${companyName}'.`);
  return first.id as string;
}

export async function getBcptLogEntries(
  baseUrl: URL, instance: string, tenant: string | undefined,
  companyId: string, suiteCode: string, sinceIso: string,
  creds: Credentials, allowInvalidCert: boolean,
): Promise<RawLogEntry[]> {
  const base = apiBase(baseUrl, instance, tenant);
  const sep = base.includes("?") ? "&" : "?";
  const filter = encodeURIComponent(`bcptCode eq '${suiteCode.replace(/'/g, "''")}' and startTime ge ${sinceIso}`);
  const url = `${base.replace(/\/$/, "")}/companies(${companyId})/bcptLogEntries${sep}$filter=${filter}`;
  const data = await getJson(url, creds, allowInvalidCert);
  return (data?.value ?? []).map((r: any): RawLogEntry => ({
    bcptCode: r.bcptCode, bcptLineNo: r.bcptLineNo,
    codeunitId: r.codeunitID ?? r.codeunitId, codeunitName: r.codeunitName,
    durationMs: r.durationMin ?? r.durationMs ?? 0,
    noOfSqlStatements: r.noOfSQLStmts ?? r.noOfSqlStatements ?? 0,
    operation: r.operation, status: r.status, startTime: r.startTime,
  }));
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npx vitest run tests/bcApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/bc/bcApi.ts tests/bcApi.test.ts
git commit -m "feat: add Performance Toolkit API client (bcptLogEntries + company id)"
```

---

## Task 4: Aggregation — per-line percentiles from raw entries

**Files:**
- Create: `src/tools/runBcpt.ts` (aggregation portion only in this task)
- Test: `tests/runBcptAggregate.test.ts`

**Interfaces:**
- Consumes: `RawLogEntry` from `src/bc/bcApi.ts`.
- Produces:
  - `type BcptLineResult = { lineNo: number; codeunitId: number; codeunitName: string; operations: number; durationAvgMs: number; durationMinMs: number; durationMaxMs: number; durationP50Ms: number; durationP90Ms: number; durationP95Ms: number; sqlStatementsAvg: number; }`
  - `type RunBcptResult = { succeeded: boolean; suiteCode: string; durationMs: number; totalOperations: number; lines: BcptLineResult[]; warnings: string[]; message: string; }`
  - `aggregate(suiteCode: string, entries: RawLogEntry[], wallMs: number, warnings: string[]) : RunBcptResult`

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, it, expect } from "vitest";
import { aggregate } from "../src/tools/runBcpt.js";

const e = (lineNo: number, durationMs: number, sql: number) => ({
  bcptCode: "S", bcptLineNo: lineNo, codeunitId: 1, codeunitName: "CU",
  durationMs, noOfSqlStatements: sql, operation: "OnRun",
  status: "Success", startTime: "2026-07-10T10:00:00Z",
});

describe("aggregate", () => {
  it("computes per-line count/min/max/avg and percentiles", () => {
    const rows = [10, 20, 30, 40, 100].map((d, i) => e(10000, d, i));
    const r = aggregate("S", rows, 5000, []);
    expect(r.succeeded).toBe(true);
    expect(r.lines).toHaveLength(1);
    const l = r.lines[0];
    expect(l.operations).toBe(5);
    expect(l.durationMinMs).toBe(10);
    expect(l.durationMaxMs).toBe(100);
    expect(l.durationAvgMs).toBe(40);
    expect(l.durationP50Ms).toBe(30);
    expect(l.durationP90Ms).toBe(100);
  });

  it("flags failure when a status is not Success and marks empty runs", () => {
    expect(aggregate("S", [], 10, []).succeeded).toBe(false);
    const bad = [{ ...e(1, 5, 0), status: "Failure" }];
    expect(aggregate("S", bad, 10, []).succeeded).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run tests/runBcptAggregate.test.ts`
Expected: FAIL — `aggregate` not found.

- [ ] **Step 3: Implement the aggregation in `src/tools/runBcpt.ts`.**

```ts
import { RawLogEntry } from "../bc/bcApi.js";

export type BcptLineResult = {
  lineNo: number; codeunitId: number; codeunitName: string; operations: number;
  durationAvgMs: number; durationMinMs: number; durationMaxMs: number;
  durationP50Ms: number; durationP90Ms: number; durationP95Ms: number;
  sqlStatementsAvg: number;
};

export type RunBcptResult = {
  succeeded: boolean; suiteCode: string; durationMs: number;
  totalOperations: number; lines: BcptLineResult[];
  warnings: string[]; message: string;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function aggregate(
  suiteCode: string, entries: RawLogEntry[], wallMs: number, warnings: string[],
): RunBcptResult {
  const byLine = new Map<number, RawLogEntry[]>();
  for (const e of entries) {
    const arr = byLine.get(e.bcptLineNo) ?? [];
    arr.push(e);
    byLine.set(e.bcptLineNo, arr);
  }
  const lines: BcptLineResult[] = [];
  for (const [lineNo, rows] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    const durs = rows.map((r) => r.durationMs).sort((a, b) => a - b);
    const sum = durs.reduce((s, d) => s + d, 0);
    const sqlSum = rows.reduce((s, r) => s + r.noOfSqlStatements, 0);
    lines.push({
      lineNo, codeunitId: rows[0].codeunitId, codeunitName: rows[0].codeunitName,
      operations: rows.length,
      durationAvgMs: Math.round(sum / rows.length),
      durationMinMs: durs[0], durationMaxMs: durs[durs.length - 1],
      durationP50Ms: percentile(durs, 50),
      durationP90Ms: percentile(durs, 90),
      durationP95Ms: percentile(durs, 95),
      sqlStatementsAvg: Math.round(sqlSum / rows.length),
    });
  }
  const anyFailure = entries.some((e) => e.status !== "Success");
  const succeeded = entries.length > 0 && !anyFailure;
  const totalOperations = entries.length;
  const message = entries.length === 0
    ? `BCPT run for '${suiteCode}' produced no log entries.`
    : `${totalOperations} operations across ${lines.length} line(s) in ${wallMs}ms${anyFailure ? " (with failures)" : ""}.`;
  return { succeeded, suiteCode, durationMs: wallMs, totalOperations, lines, warnings, message };
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npx vitest run tests/runBcptAggregate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/tools/runBcpt.ts tests/runBcptAggregate.test.ts
git commit -m "feat: add BCPT per-line percentile aggregation"
```

---

## Task 5: Input schema, `createRunBcpt` orchestration skeleton, and tool registration

**Files:**
- Modify: `src/tools/runBcpt.ts` (add schema + `createRunBcpt`)
- Modify: `src/tools/register.ts`
- Test: `tests/runBcptInput.test.ts`

**Interfaces:**
- Consumes: `readLaunchConfig`, `loadCredentials`, `normalizeServerUrl`, `withHubLock`, `redact` (`src/bc/connection.ts`); `getCompanyId`, `getBcptLogEntries` (`src/bc/bcApi.ts`); `aggregate`, `RunBcptResult` (this file); `startBcptRun` (Task 6, `src/bc/clientSession.ts`).
- Produces: `RunBcptInput` (Zod), `createRunBcpt(primaryWorkspace: string) : (input) => Promise<RunBcptResult>`.

- [ ] **Step 1: Write the failing schema test.**

```ts
import { describe, it, expect } from "vitest";
import { RunBcptInput } from "../src/tools/runBcpt.js";

describe("RunBcptInput", () => {
  it("requires suiteCode and defaults optional fields", () => {
    expect(RunBcptInput.safeParse({}).success).toBe(false);
    const ok = RunBcptInput.safeParse({ suiteCode: "SALES" });
    expect(ok.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run tests/runBcptInput.test.ts`
Expected: FAIL — `RunBcptInput` not found.

- [ ] **Step 3: Add the schema and orchestration to `src/tools/runBcpt.ts`.** `startBcptRun` is imported from Task 6; until Task 6 lands it is a stub that throws — this task's deliverable is the schema + wiring, verified by the schema test and `tsc`.

```ts
import { z } from "zod";
import { readLaunchConfig, normalizeServerUrl, loadCredentials, withHubLock, redact } from "../bc/connection.js";
import { getCompanyId, getBcptLogEntries } from "../bc/bcApi.js";
import { startBcptRun } from "../bc/clientSession.js";
import { resolve } from "node:path";

export const RunBcptInput = z.object({
  suiteCode: z.string().min(1).describe("BCPT Suite code to run (must already exist in the target)."),
  projectPath: z.string().optional().describe("AL folder with .vscode/launch.json. Defaults to the bridge's primary workspace."),
  launchConfig: z.string().optional().describe("Named launch.json configuration. Defaults to the first."),
  company: z.string().optional().describe("Company name. Defaults to launch.json startupCompany."),
  timeoutSeconds: z.number().int().positive().optional().describe("Max seconds to wait for the run. Default 900."),
  allowInvalidCert: z.boolean().optional().describe("Skip TLS validation. Default false."),
});
export type RunBcptInputT = z.infer<typeof RunBcptInput>;

export function createRunBcpt(primaryWorkspace: string) {
  return async (input: RunBcptInputT): Promise<RunBcptResult> => {
    const warnings: string[] = [];
    const projectPath = resolve(input.projectPath ?? primaryWorkspace);
    const cfg = readLaunchConfig(projectPath, input.launchConfig);
    const serverUrl = normalizeServerUrl(cfg.server, cfg.port);
    if (serverUrl.protocol === "http:") warnings.push("launch.json server URL uses plain HTTP — credentials will travel unencrypted.");
    const creds = loadCredentials(serverUrl.origin, cfg.serverInstance);
    const company = input.company ?? cfg.startupCompany ?? "";
    const allowInvalidCert = input.allowInvalidCert === true || process.env.BC_ALLOW_INVALID_CERT === "1" || cfg.validateServerCertificate === false;
    const timeoutMs = (input.timeoutSeconds ?? 900) * 1000;
    const lockKey = `${serverUrl.origin.toLowerCase()}|${cfg.serverInstance.toLowerCase()}|${cfg.tenant ?? ""}`;

    return withHubLock(lockKey, async () => {
      const t0 = Date.now();
      const sinceIso = new Date(t0).toISOString();
      try {
        await startBcptRun({ serverUrl, instance: cfg.serverInstance, tenant: cfg.tenant, company, creds, allowInvalidCert, suiteCode: input.suiteCode, timeoutMs });
        const companyId = await getCompanyId(serverUrl, cfg.serverInstance, cfg.tenant, company, creds, allowInvalidCert);
        const entries = await getBcptLogEntries(serverUrl, cfg.serverInstance, cfg.tenant, companyId, input.suiteCode, sinceIso, creds, allowInvalidCert);
        return aggregate(input.suiteCode, entries, Date.now() - t0, warnings);
      } catch (err) {
        throw new Error(redact(err instanceof Error ? err.message : String(err)));
      }
    });
  };
}
```

- [ ] **Step 4:** Register the tool in `register.ts`. Add the import and factory call next to `runTests`, and the `mcp.registerTool` block.

```ts
// with the other imports
import { RunBcptInput, createRunBcpt } from "./runBcpt.js";
// with the other factory calls
const runBcpt = createRunBcpt(config.workspaceRoot);
// with the other registrations
mcp.registerTool(
  "al_run_bcpt",
  {
    description:
      "Run a Business Central Performance Toolkit (BCPT) suite headlessly against an " +
      "on-premise dev service tier and return per-line duration/SQL percentiles. Reads " +
      "connection info from .vscode/launch.json; credentials from BC_USER/BC_PASSWORD or " +
      "~/.config/al-mcp-bridge/credentials.json. The suite must already exist (by code). " +
      "Network-only — no BcContainerHelper, no container-host access, no custom AL.",
    inputSchema: RunBcptInput.shape,
  },
  async (input) => json(await runBcpt(input)),
);
```

- [ ] **Step 5:** Run schema test + build.

Run: `npx vitest run tests/runBcptInput.test.ts && npm run build`
Expected: schema test PASS; `tsc` may report only that `startBcptRun` is unresolved **until Task 6** — if Task 6 is not yet done, add a temporary stub `export async function startBcptRun(_: unknown): Promise<void> { throw new Error("startBcptRun not implemented (Task 6)"); }` in `src/bc/clientSession.ts` so the build is green.

- [ ] **Step 6: Commit.**

```bash
git add src/tools/runBcpt.ts src/tools/register.ts tests/runBcptInput.test.ts src/bc/clientSession.ts
git commit -m "feat: register al_run_bcpt with input schema and orchestration"
```

---

## Task 6: `clientSession.ts` — `/cs/` start automation (post-spike)

> **Gated on Task 1 GO.** Implement to the envelope shapes captured in `.dev/cs-protocol-notes.md`. The interaction sequence is fixed (below); the exact JSON frames come from the spike. Because the wire format is discovered in Task 1, the frame-construction code is written against those notes, not guessed here.

**Files:**
- Modify: `src/bc/clientSession.ts` (replace the Task-5 stub)
- Test: `tests/clientSession.test.ts` (frame construction against captured fixtures)

**Interfaces:**
- Consumes: `Credentials` (`connection.ts`); the captured frames from `.dev/cs-protocol-notes.md`.
- Produces: `startBcptRun(args: { serverUrl: URL; instance: string; tenant?: string; company: string; creds: Credentials; allowInvalidCert: boolean; suiteCode: string; timeoutMs: number }) : Promise<void>`

- [ ] **Step 1:** Implement the transport: open a WebSocket (or long-poll, per the spike) to `{serverUrl}/{instance}/cs/?tenant=<t>&company=<c>` with the `Authorization: Basic` header; implement `openSession()`, `invokeInteraction(interaction)` with the `sequenceNo` counter, and a `parseForm(response)` that returns a control map — exactly matching the frames in `.dev/cs-protocol-notes.md`.

- [ ] **Step 2: Write a fixture test** using a captured `OpenForm(149002)` response saved from the spike (`tests/fixtures/cs-openform-149002.json`): assert `parseForm` extracts the suite-code control and the Start action by name.

- [ ] **Step 3:** Implement `startBcptRun`: `openSession` → `openForm(149002)` → `saveValue(suiteCodeControl, suiteCode)` → `invokeAction(startAction)` → poll the status control every 2s until it reads complete or `timeoutMs` elapses (throw `BcConnectionError` on timeout, with partial state) → `closeForm`/`closeSession`.

- [ ] **Step 4:** Run tests + build.

Run: `npx vitest run tests/clientSession.test.ts && npm run build`
Expected: PASS; clean build.

- [ ] **Step 5: Live smoke test** against the container (needs env creds + an existing suite).

Run: `BC_USER=... BC_PASSWORD=... npx vitest run tests/integration/runBcpt.live.test.ts` (guarded by a `BC_LIVE=1` env gate so CI skips it)
Expected: `succeeded:true`, non-empty `lines` with plausible durations.

- [ ] **Step 6: Commit.**

```bash
git add src/bc/clientSession.ts tests/clientSession.test.ts tests/fixtures/cs-openform-149002.json
git commit -m "feat: implement /cs/ client-service BCPT start automation"
```

---

## Task 7: Docs + README entry

**Files:**
- Modify: `README.md` (tool table + a short `al_run_bcpt` section)

- [ ] **Step 1:** Add `al_run_bcpt` to the README tool list mirroring the `al_run_tests` entry: inputs (`suiteCode`, optional `company`/`timeoutSeconds`), the prerequisite (a defined BCPT suite + Performance Toolkit installed on BC ≥ 20), and the network-only/no-host note.

- [ ] **Step 2: Commit.**

```bash
git add README.md
git commit -m "docs: document al_run_bcpt tool"
```

---

## Self-Review

**Spec coverage:** §3 contract → Tasks 4/5 (schema + result shape). §4 architecture (`src/bc/` split, `bcApi`, `clientSession`) → Tasks 2/3/6. §5.1 start automation → Task 6 (gated by Task 1 spike). §5.2 read → Task 3. §5.3 spike → Task 1. §7 security/concurrency (`redact`, `withHubLock`, HTTP warning, timeout) → Task 5. §8 testing → Tasks 3/4/6. Open questions §9(1–3) resolved by Task 1; §9(4) `startTime` watermark used in Task 5; §9(5) company resolution in Task 3/5; §9(6) PerfToolkit presence surfaces as a clear API/`/cs/` error.

**Placeholders:** none in Tasks 2–5/7 (full code). Tasks 1 and 6 are explicitly spike-gated: their frame-level code derives from `.dev/cs-protocol-notes.md` produced in Task 1 — a deliberate, documented dependency, not a hidden TODO.

**Type consistency:** `RawLogEntry` (Task 3) consumed by `aggregate` (Task 4) and orchestration (Task 5). `RunBcptResult`/`BcptLineResult` defined in Task 4, returned by Task 5. `startBcptRun` signature identical in Task 5 (consumer) and Task 6 (producer). Shared helpers exported in Task 2 match the imports in Tasks 3/5.

**Ordering:** Task 1 (spike) gates Task 6 only. Tasks 2→3→4→5 are a clean dependency chain and can proceed regardless of the spike; Task 6 wires in last. Task 5 Step 5 notes the temporary `startBcptRun` stub so the build stays green before Task 6.

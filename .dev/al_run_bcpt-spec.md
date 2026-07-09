# Design Spec — `al_run_bcpt`

**Status:** Draft for review
**Date:** 2026-07-10
**Branch:** `feat/al-run-bcpt`
**Author:** trto (with Claude)

## 1. Goal

Add an MCP tool `al_run_bcpt` that runs a **Business Central Performance Toolkit (BCPT)**
suite against an on-prem BC dev service tier and returns per-line performance metrics
(duration + SQL statistics, aggregated across sessions × iterations).

It is the performance sibling of `al_run_tests`: same connection model
(`.vscode/launch.json` + Basic auth), same security posture, pure TypeScript,
no Windows/container dependency.

### Non-goals

- **No BcContainerHelper / `Run-BCPTTestsInBcContainer`.** Explicitly excluded — the
  whole point is to stay within the bridge's cross-platform, cmdlet-free design.
- **Not** authoring or editing BCPT suites/lines. The tool runs an **existing** suite
  identified by its code. Suite definition stays a manual/AL concern.
- **Not** SaaS/cloud. On-prem + `UserPassword` auth only, matching `al_run_tests`.
- **Not** a single-session microbenchmark. This drives a real BCPT run (N sessions ×
  M iterations), not a one-shot codeunit timing.

## 2. Why this is not a copy of `al_run_tests`

`al_run_tests` works because BC's dev tier exposes a dedicated **`TestRunnerHub`**
SignalR endpoint. **BCPT has no equivalent hub.** A BCPT run is normally started by the
**"Start" action on the `BCPT Suites` page**, which spawns background sessions
server-side; results are written to the **`BCPT Log Entry`** table. So the tool's hard
problems are (a) **starting** the run headlessly and (b) **reading** the results —
neither of which the test-runner path solves.

## 3. Tool contract (stable across backends)

Registered exactly like `al_run_tests` in `src/tools/register.ts`
(`createRunBcpt(config.workspaceRoot)` → `mcp.registerTool("al_run_bcpt", …)`), no
`lspReady` wait (talks to BC directly).

### Input (`RunBcptInput`, Zod)

| field | type | notes |
|---|---|---|
| `suiteCode` | `string` (required) | BCPT Suite code to run (e.g. `"SALES"`). |
| `projectPath` | `string?` | AL folder with `.vscode/launch.json`. Defaults to primary workspace. |
| `launchConfig` | `string?` | Named launch config. Defaults to first. |
| `durationMinutes` | `number?` | Optional cap; overrides suite default duration if the trigger supports it. |
| `timeoutSeconds` | `number?` | Client-side wait ceiling before giving up polling. Default e.g. 900. |
| `allowInvalidCert` | `boolean?` | Same semantics/precedence as `al_run_tests`. |

### Output (`RunBcptResult`)

```
{
  succeeded: boolean,
  suiteCode: string,
  durationMs: number,          // wall clock of the whole run
  totalSessions: number,
  totalIterations: number,
  lines: BcptLineResult[],
  warnings: string[],
  message: string
}
```

```
BcptLineResult {
  lineNo: number,
  codeunitId: number,
  codeunitName: string,
  operations: number,          // logged executions for this line
  durationAvgMs, durationMinMs, durationMaxMs: number,
  durationP50Ms, durationP90Ms, durationP95Ms: number,
  sqlStatementsAvg: number,
  sqlDurationAvgMs: number
}
```

Percentiles/aggregates are computed **client-side in TS** from raw `BCPT Log Entry`
rows so the shape is identical regardless of how results are read.

## 4. Architecture

`src/tools/runBcpt.ts` exposes `createRunBcpt(primaryWorkspace)`, orchestrating three
phases:

```
start(conn, suiteCode, opts)             // client-service automation of page 149002 (§5.1)
waitForCompletion(conn, suiteCode)       // poll form status until the run ends (§5.1)
readEntries(conn, companyId, suiteCode)  // GET bcptLogEntries API, then aggregate (§5.2)
```

The connection layer — launch.json parsing, credential loading, TLS handling,
redaction, run serialization — is **reused from `runTests.ts`**, lifted into a shared
`src/bc/` module (`readLaunchConfig`, `normalizeServerUrl`, `loadCredentials`, `redact`,
`withHubLock`). Two new pieces live under `src/bc/`:
- `clientSession.ts` — the `/cs/` client-service protocol client (§5.1).
- `bcApi.ts` — thin OData/API helper for the Performance Toolkit endpoints (§5.2).

> Refactor note: `runTests.ts` owns the connection helpers privately today. Lifting them
> into `src/bc/` (no behavior change, existing tests guard it) is part of this work.

## 5. Chosen approach — client-service automation (network-only; no AL, no host)

Investigation (§6) established that BCPT has **no public programmatic start** on BC 28.3
and **no container-host access** is available, so `al_run_bcpt` starts a suite the same
way Microsoft's own `RunBCPTTests.ps1` does: by driving the **BCPT test-runner page
149002** over the **`/cs/` client-service endpoint**, then reading results over the
**shipped Performance Toolkit API**. Everything is network-only against the BC web-client
URL — no Docker host, no BcContainerHelper, no custom AL (28.3 ≥ v20 ships the APIs).

### 5.1 Start — port of the `ClientContext` interaction sequence

`src/bc/clientSession.ts` reimplements the `/cs/` JSON-RPC 2.0 protocol (spoken by
`Microsoft.Dynamics.Framework.UI.Client`; `ClientContext.ps1` is the high-level
reference, the Frycos write-up documents the wire format). Endpoint:
`{PublicWebBaseUrl}/cs/?tenant=<t>&company=<c>`, Basic auth (reused from `runTests.ts`).
The narrow interaction sequence (from `ClientContext.ps1` + `RunBCPTTests.ps1`):

1. `OpenSession` — negotiate a client session.
2. `OpenForm(149002)` — the BCPT test-runner card.
3. `GetControlByName` + `SaveValue` — set the suite code (+ any run params).
4. `GetActionByName(form, "Start")` + `InvokeAction` — start the run.
5. Poll a status control until the run reports complete, bounded by `timeoutSeconds`
   and the suite duration.
6. `CloseForm` / `CloseSession`.

Only the interactions this flow needs are implemented (OpenSession, InvokeInteraction
with OpenForm/SaveValue/InvokeAction, form/control-state parsing) — not the full client.

### 5.2 Read — shipped Performance Toolkit API

`src/bc/bcApi.ts` calls the standard API (network, Basic auth):
`GET /api/microsoft/performancToolkit/v1.0/companies({id})/bcptLogEntries` (company id via
`GET .../companies?$filter=name eq '…'`). Present in the base Performance Toolkit app for
BC ≥ 20 — **28.3 needs no injected page.** Percentiles/aggregates are computed
client-side in TS. Suite existence is assumed by code; optional creation via
`POST .../bcptSuites`.

### 5.3 Feasibility spike (phase 1, make-or-break)

The `/cs/` wire protocol is the biggest single task and the only real risk. Phase 1 is a
minimal spike — `OpenSession` + `OpenForm(149002)` + dump controls against a live
container. If the handshake works, steps 3–6 are incremental and §5.2 is trivial. If it
proves too costly, stop and reconsider (e.g. obtaining host access) before the full build.

## 6. Approaches considered and rejected

Recorded so the decision isn't re-litigated:

- **A — shell out to `Run-BCPTTestsInBcContainer`.** Infeasible: it runs *on* the Docker
  host via `Invoke-ScriptInBcContainer`; we have **no host access**. (Also the dependency
  we set out to avoid.)
- **Zero-AL via the dev `TestRunnerHub`.** `BCPT Start Tests` (CU 149000) is
  `Access = Internal` and not a test codeunit — not invokable via the hub or any app.
  `BCPT Test Suite` (CU 149006, public) exposes config/status only, **no run method**;
  `BCPT Suite API` has **no `ServiceEnabled` start action**. Verified against 28.3
  (`releases/28.3/StrictMode`, `e3c20b9`). → **no public programmatic start exists.**
- **Custom AL helper app that calls the start codeunit.** Impossible for the same reason
  (nothing public to call; can't replicate the start without the Internal
  `BCPT Role Wrapper`). Reading is already covered by the shipped `bcptLogEntries` API, so
  no helper is needed. The `bcpt-helper/` scaffold built earlier was removed.

## 7. Error handling, concurrency, security

- Serialize concurrent BCPT runs against the same server via the existing
  `withHubLock` keyed on `{origin}|{instance}|{tenant}` — BCPT sessions are heavy and
  a suite should not run twice at once.
- All error strings pass through `redact()` before leaving the module — credentials
  never logged or returned (same guarantee as `al_run_tests`).
- Plain-HTTP launch URLs raise the same "credentials travel unencrypted" warning.
- Long runs: `timeoutSeconds` bounds the poll loop; on timeout return
  `succeeded:false` with a clear message and any partial entries read so far.

## 8. Testing

- Unit: percentile/aggregation math from fixture `BCPT Log Entry` rows; input schema
  validation; shared-helper refactor keeps `runTests` tests green.
- Integration (opt-in, needs a container + a defined BCPT suite): run a tiny suite,
  assert non-empty per-line metrics and `succeeded:true`.
- Reuse the repo's existing test harness/style (`tests/`).

## 9. Open questions

1. **`/cs/` wire protocol (the phase-1 spike, §5.3):** exact `OpenSession` handshake,
   the `InvokeInteraction` envelope, and how form/control state is returned/parsed.
   Reference: `ClientContext.ps1` (interaction names) + the Frycos protocol write-up.
2. Page 149002 control/action names: the suite-code control and the Start action
   (`GetControlByName`/`GetActionByName` targets) — confirm against a live card.
3. Completion detection: a status control on page 149002 vs. polling `bcptSuites` /
   entry-count quiescence, bounded by `timeoutSeconds` + suite duration.
4. Result correlation: filter `bcptLogEntries` by BCPT code + a `Start Time` watermark
   taken just before `start()`, or is `RunID` (field 18) exposed on the API page?
5. Company resolution: `launch.json` `startupCompany` vs. `GET .../companies` lookup for
   the API company id.
6. Is the Performance Toolkit app installed in the target? Both `/cs/` page 149002 and
   the `bcptLogEntries` API require it; fail with a clear message if absent.

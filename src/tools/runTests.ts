/**
 * al_run_tests — execute AL test codeunits against a Business Central dev
 * service tier from Linux. Reimplements the SignalR hub protocol Microsoft's
 * own tool uses (see decompiled `HubBasedTestRunnerService`) but with an
 * auth path that does not rely on Windows-only DPAPI credential storage.
 *
 * Protocol (verified in Microsoft.Dynamics.Nav.LanguageModelTools v17.0.34):
 *   hub       : {server}/{instance}/dev/TestRunnerHub?tenant=...&deploymentId=...
 *   auth      : HTTP Basic — `Authorization: Basic base64(user:pass)`
 *               (the reference client also mirrors the header as an
 *               `Authentication=` query param for the WebSocket upgrade)
 *   invoke    : Initialize(company, debuggingContext, coverageMode)
 *               RunTests(codeunitId, methodNames[])
 *   listen    : TestStarted(codeunitId, method)
 *               TestCompleted(codeunitId, method, status, output, durationMs)
 *               TestRunCompleted(coverage) — fires once per codeunit group
 *               RuntimeInitialized()
 *
 * Credential security:
 *   - Read-only. This tool never writes credentials to disk.
 *   - Env vars `BC_USER` + `BC_PASSWORD` take precedence.
 *   - File fallback at `$XDG_CONFIG_HOME/al-mcp-bridge/credentials.json`
 *     (default `~/.config/...`); file must be mode 0600 — stricter is fine,
 *     any group/world-readable bit causes a hard refusal.
 *   - Password is never logged, never returned in the MCP response, and
 *     scrubbed from error strings before they leave this module.
 */

import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  HttpTransportType,
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from "@microsoft/signalr";
import {
  BcConnectionError,
  Credentials,
  LaunchConfig,
  describeError,
  loadCredentials,
  normalizeServerUrl,
  readLaunchConfig,
  redact,
  withHubLock,
} from "../bc/connection.js";

// ---------------------------------------------------------------------------
// MCP-facing input schema
// ---------------------------------------------------------------------------

export const RunTestsInput = z.object({
  codeunitId: z
    .number()
    .int()
    .describe("The test codeunit ID to run (e.g. 95003)."),
  testMethods: z
    .array(z.string())
    .optional()
    .describe(
      "Optional subset of test methods within the codeunit. Runs all methods if omitted.",
    ),
  projectPath: z
    .string()
    .optional()
    .describe(
      "AL project folder containing .vscode/launch.json. Defaults to the bridge's primary workspace.",
    ),
  launchConfig: z
    .string()
    .optional()
    .describe(
      "Name of the launch.json configuration to use. Defaults to the first entry.",
    ),
  company: z
    .string()
    .optional()
    .describe(
      "Startup company (overrides launch.json's `startupCompany`). Defaults to empty string.",
    ),
  allowInvalidCert: z
    .boolean()
    .optional()
    .describe(
      "Skip TLS certificate validation. Default false. Prefer fixing the server cert over enabling this.",
    ),
});

export type RunTestsInputT = z.infer<typeof RunTestsInput>;

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type TestResultStatus = "Passed" | "Failed" | "Skipped" | "Unknown";

export interface TestMethodResult {
  codeunitId: number;
  methodName: string;
  status: TestResultStatus;
  output: string;
  durationMs: number;
}

export interface RunTestsResult {
  succeeded: boolean;
  codeunitId: number;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  durationMs: number;
  tests: TestMethodResult[];
  warnings: string[];
  message: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function createRunTests(primaryWorkspace: string) {
  return async (input: RunTestsInputT): Promise<RunTestsResult> => {
    const warnings: string[] = [];
    const projectPath = resolve(input.projectPath ?? primaryWorkspace);
    const launchCfg = readLaunchConfig(projectPath, input.launchConfig);

    if (launchCfg.environmentType && launchCfg.environmentType !== "OnPrem") {
      throw new BcConnectionError(
        `Only on-premise launch configurations are supported at the moment. Got environmentType='${launchCfg.environmentType}'.`,
      );
    }
    if (launchCfg.authentication && launchCfg.authentication !== "UserPassword") {
      throw new BcConnectionError(
        `Only authentication='UserPassword' is supported at the moment. Got authentication='${launchCfg.authentication}'.`,
      );
    }

    const serverUrl = normalizeServerUrl(launchCfg.server, launchCfg.port);
    if (serverUrl.protocol === "http:") {
      warnings.push(
        `launch.json server URL uses plain HTTP — credentials will travel unencrypted.`,
      );
    }

    const creds = loadCredentials(serverUrl.origin, launchCfg.serverInstance);

    const hubUrl = buildHubUrl(serverUrl, launchCfg.serverInstance, launchCfg.tenant);
    // Default company is empty string — matches MS's own reference tool
    // (lmt.cs:1127 passes `parameters.Company ?? string.Empty`, ignoring
    // launch.json's `startupCompany`). Empirically, passing a named
    // company that the server disagrees with surfaces as a generic
    // `An unexpected error occurred invoking 'Initialize' on the server.`
    // SignalR error. Callers who need a specific company must pass it
    // explicitly via `company`.
    const company = input.company ?? "";
    const methods = input.testMethods ?? [];

    // Precedence for cert handling, strictest to loosest:
    //   1. explicit tool input `allowInvalidCert: true`
    //   2. env var `BC_ALLOW_INVALID_CERT=1` (MCP-server scope)
    //   3. launch.json `"validateServerCertificate": false` (project scope)
    // Default: validate (secure).
    const allowInvalidCert =
      input.allowInvalidCert === true ||
      process.env.BC_ALLOW_INVALID_CERT === "1" ||
      launchCfg.validateServerCertificate === false;

    // Serialize concurrent runs against the same hub — BC's test-runner
    // singleton rejects parallel Initialize calls with a generic error.
    const lockKey = `${serverUrl.origin.toLowerCase()}|${launchCfg.serverInstance.toLowerCase()}|${launchCfg.tenant ?? ""}`;

    return withHubLock(lockKey, async () => {
      const results: TestMethodResult[] = [];
      const t0 = Date.now();
      const connection = buildConnection(hubUrl, creds, allowInvalidCert);

      const runCompleted = new Promise<void>((resolvePromise, rejectPromise) => {
        connection.on("TestStarted", () => {
          // could surface progress later; keep quiet for now
        });
        connection.on(
          "TestCompleted",
          (
            codeunitId: number,
            methodName: string,
            status: number | string,
            output: string,
            durationMs: number,
          ) => {
            results.push({
              codeunitId,
              methodName,
              status: coerceStatus(status),
              output: output ?? "",
              durationMs: Number(durationMs) || 0,
            });
          },
        );
        connection.on("TestRunCompleted", () => {
          resolvePromise();
        });
        connection.onclose((err) => {
          if (err) rejectPromise(new BcConnectionError(redact(String(err))));
          else resolvePromise();
        });
      });

      try {
        await connection.start();
        // Initialize: (companyName, debuggingContext, coverageMode=0 None)
        await connection.invoke("Initialize", company, "", 0);
        // RunTests: (codeunitId, methodNames[])
        await connection.invoke("RunTests", input.codeunitId, methods);
        await runCompleted;
      } catch (err: unknown) {
        throw new BcConnectionError(redact(describeError(err)));
      } finally {
        if (connection.state !== HubConnectionState.Disconnected) {
          try {
            await connection.stop();
          } catch {
            // swallow — we already have (or are raising) the primary error
          }
        }
      }

      const elapsed = Date.now() - t0;
      return summarize(input.codeunitId, results, warnings, elapsed);
    });
  };
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

/** Compose `{origin}[:port]/{instance}/dev/TestRunnerHub` + tenant query param. */
function buildHubUrl(
  serverUrl: URL,
  serverInstance: string,
  tenant?: string,
): string {
  const base = new URL(serverUrl.toString());
  // strip any path the user might've included on the server URL
  base.pathname = "/";
  const path =
    `/${encodeURIComponent(serverInstance)}/dev/TestRunnerHub`.replace(
      /\/+/g,
      "/",
    );
  base.pathname = path;
  if (tenant) base.searchParams.set("tenant", tenant);
  return base.toString();
}

// ---------------------------------------------------------------------------
// SignalR connection
// ---------------------------------------------------------------------------

function buildConnection(
  hubUrl: string,
  creds: Credentials,
  allowInvalidCert: boolean,
): HubConnection {
  const basic =
    "Basic " +
    Buffer.from(`${creds.username}:${creds.password}`, "utf8").toString(
      "base64",
    );

  // `@microsoft/signalr` accepts an `httpClient` override and per-transport
  // options. For Node we rely on its default Node http/ws stack. TLS
  // validation bypass is plumbed via `NODE_TLS_REJECT_UNAUTHORIZED` only
  // when the caller opts in, and scoped to this process — not child procs.
  if (allowInvalidCert) {
    // Node-only, non-public API on global process — but the only way to
    // get `@microsoft/signalr`'s bundled ws client to relax cert checks
    // without swapping out its HttpClient. Scope is the whole Node process;
    // MCP server is single-purpose so this is acceptable with an opt-in.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  return new HubConnectionBuilder()
    .withUrl(hubUrl, {
      headers: { Authorization: basic },
      // The reference implementation mirrors the auth header as a query
      // param for the WebSocket upgrade step. We include it via
      // accessTokenFactory so the underlying transport attaches it as
      // `access_token` — but BC expects `Authentication=<header>` instead.
      // We add that via URL directly after the builder if needed; for now
      // the Authorization header alone works on BC's dev tier because it
      // accepts Basic for both negotiate and WS upgrade.
      transport:
        HttpTransportType.WebSockets |
        HttpTransportType.ServerSentEvents |
        HttpTransportType.LongPolling,
      skipNegotiation: false,
    })
    .configureLogging(LogLevel.Error)
    .build();
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function coerceStatus(s: number | string): TestResultStatus {
  // TestResultStatus enum (lmt.cs:1063): 0 Passed, 1 Failed, 2 Skipped
  if (typeof s === "number") {
    switch (s) {
      case 0:
        return "Passed";
      case 1:
        return "Failed";
      case 2:
        return "Skipped";
      default:
        return "Unknown";
    }
  }
  if (typeof s === "string") {
    const v = s.trim();
    if (v === "Passed" || v === "Failed" || v === "Skipped") return v;
  }
  return "Unknown";
}

function summarize(
  codeunitId: number,
  tests: TestMethodResult[],
  warnings: string[],
  durationMs: number,
): RunTestsResult {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const t of tests) {
    if (t.status === "Passed") passed++;
    else if (t.status === "Failed") failed++;
    else if (t.status === "Skipped") skipped++;
  }
  const succeeded = failed === 0 && tests.length > 0;
  const message =
    tests.length === 0
      ? `Test run completed but no test results were returned for codeunit ${codeunitId}.`
      : `${passed} passed, ${failed} failed, ${skipped} skipped (${tests.length} total) in ${durationMs}ms.`;
  return {
    succeeded,
    codeunitId,
    passed,
    failed,
    skipped,
    total: tests.length,
    durationMs,
    tests,
    warnings,
    message,
  };
}

// Silence unused-import warning for `dirname`/`isAbsolute` if not used in
// future expansions. We keep them imported for the file-cred loader if we
// later support relative-to-workspace credential files.
void dirname;
void isAbsolute;

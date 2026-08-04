import { z } from "zod";
import { resolve } from "node:path";
import { readLaunchConfig, normalizeServerUrl, loadCredentials, withHubLock, redact } from "../bc/connection.js";
import { loadTimeouts } from "../timeouts.js";
import { getCompanyId, getBcptLogEntries, RawLogEntry } from "../bc/bcApi.js";

export type BcptLineResult = {
  lineNo: number; codeunitId: number; codeunitName: string; operations: number;
  durationAvgMs: number; durationMinMs: number; durationMaxMs: number;
  durationP50Ms: number; durationP90Ms: number; durationP95Ms: number;
  sqlStatementsAvg: number;
};

export type RunBcptResult = {
  succeeded: boolean; suiteCode: string; queryMs: number;   // wall time of the API read, NOT the BCPT run duration
  totalOperations: number; lines: BcptLineResult[];
  warnings: string[]; message: string;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function aggregate(
  suiteCode: string, entries: RawLogEntry[], queryMs: number, warnings: string[],
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
    : `${totalOperations} operations across ${lines.length} line(s)${anyFailure ? " (with failures)" : ""} (read in ${queryMs}ms).`;
  return { succeeded, suiteCode, queryMs, totalOperations, lines, warnings, message };
}

// ---------------------------------------------------------------------------
// MCP-facing input schema + orchestration
// ---------------------------------------------------------------------------

export const RunBcptInput = z.object({
  suiteCode: z.string().min(1).describe("BCPT Suite code whose logged results to read (the suite must have been run — e.g. started from the BC web client or a scheduled/CI run)."),
  projectPath: z.string().optional().describe("AL folder with .vscode/launch.json. Defaults to the bridge's primary workspace."),
  launchConfig: z.string().optional().describe("Named launch.json configuration. Defaults to the first."),
  company: z.string().optional().describe("Company name. Defaults to launch.json startupCompany."),
  sinceMinutes: z.number().int().positive().optional().describe("Only aggregate log entries from the last N minutes (the most recent run). Omit to aggregate ALL entries for the suite."),
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
    // The BC API/OData is served under a different instance than launch.json's dev tier.
    // Verified live on bench-test-28-2: the dev instance is "<base>-dev" and the API lives
    // at "<base>-rest" (the dev instance returns 503 for /api). On a vanilla single-instance
    // container both share the same instance. Derive accordingly; allow an explicit override.
    const apiInstance = process.env.BC_BCPT_API_INSTANCE?.trim()
      || (cfg.serverInstance.endsWith("-dev") ? cfg.serverInstance.replace(/-dev$/, "-rest") : cfg.serverInstance);
    const lockKey = `${serverUrl.origin.toLowerCase()}|${cfg.serverInstance.toLowerCase()}|${cfg.tenant ?? ""}`;

    // Read/aggregate mode: BCPT has no supported headless *start* over the network
    // (see .dev/cs-protocol-notes.md), so the run is started externally (BC web client
    // "Start", or a scheduled/CI run) and this reads + aggregates the logged results.
    const sinceIso = input.sinceMinutes ? new Date(Date.now() - input.sinceMinutes * 60_000).toISOString() : undefined;
    return withHubLock(lockKey, loadTimeouts().toolMs, async () => {
      const t0 = Date.now();
      try {
        const companyId = await getCompanyId(serverUrl, apiInstance, cfg.tenant, company, creds, allowInvalidCert);
        const entries = await getBcptLogEntries(serverUrl, apiInstance, cfg.tenant, companyId, input.suiteCode, sinceIso, creds, allowInvalidCert);
        return aggregate(input.suiteCode, entries, Date.now() - t0, warnings);
      } catch (err) {
        throw new Error(redact(err instanceof Error ? err.message : String(err)));
      }
    });
  };
}

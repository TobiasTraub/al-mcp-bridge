import { z } from "zod";
import { resolve } from "node:path";
import { readLaunchConfig, normalizeServerUrl, loadCredentials, withHubLock, redact, deriveApiInstance } from "../bc/connection.js";
import { loadTimeouts } from "../timeouts.js";
import { getCompanyId } from "../bc/bcApi.js";
import { callPerfProcedure, ensureOnPremOptIn, PerfProcedure } from "../bc/perfToolkit.js";

export type RunPerfResult = {
  succeeded: boolean;
  action: string;
  gate?: "pass" | "fail";
  optIn?: { wasAllowed: boolean; allowed: boolean };
  document?: unknown;
  warnings: string[];
  message: string;
};

export const RunPerfInput = z.object({
  action: z.enum(["run", "list", "setBaseline", "compare", "optIn"]).optional()
    .describe("run (default): RunScenario. list: ListScenarios. setBaseline: SetBaseline(entryNo). compare: CompareRuns(entryNo, baseEntryNo). optIn: only set allowOnPremRuns on the toolkit setup."),
  scenario: z.string().optional().describe("run: enum value name of the scenario (as ListScenarios reports it), e.g. 'Smoke'."),
  iterations: z.number().int().min(0).max(50).optional().describe("run: measured iterations, 0 or omitted = 5, clamped to 1..50 by the toolkit (plus one warm-up)."),
  label: z.string().optional().describe("run: label stored with the run, e.g. 'base' / 'head' / a commit sha."),
  runContext: z.string().optional().describe("run: free text stored with the run - put the app versions / commit here, it is the only record of which build ran."),
  markAsBaseline: z.boolean().optional().describe("run: make this run the scenario's baseline (ignored for a failed run)."),
  tolerancePct: z.number().min(0).optional().describe("run: tolerated SQL/rows increase in percent against the baseline before 'Regressed' (default 0)."),
  entryNo: z.number().int().positive().optional().describe("setBaseline / compare: entry number of the run (the head run for compare)."),
  baseEntryNo: z.number().int().min(0).optional().describe("compare: entry number of the base run; 0 or omitted = the scenario's current baseline."),
  ensureOptIn: z.boolean().optional().describe("run / setBaseline: first set allowOnPremRuns on the toolkit setup (needed once per company on SOCITAS on-prem containers, which report IsProduction = true). Default false."),
  projectPath: z.string().optional().describe("AL folder with .vscode/launch.json (any app on the target container). Defaults to the bridge's primary workspace."),
  launchConfig: z.string().optional().describe("Named launch.json configuration. Defaults to the first."),
  company: z.string().optional().describe("Company name. Defaults to launch.json startupCompany."),
  allowInvalidCert: z.boolean().optional().describe("Skip TLS validation. Default false."),
});
export type RunPerfInputT = z.infer<typeof RunPerfInput>;

const PROCEDURES: Record<string, PerfProcedure> = {
  run: "RunScenario", list: "ListScenarios", setBaseline: "SetBaseline", compare: "CompareRuns",
};

/**
 * Validates the action-specific inputs and builds the procedure's JSON body.
 * The body keys must match the web-service parameter names exactly.
 */
export function buildParams(input: RunPerfInputT): Record<string, unknown> {
  const action = input.action ?? "run";
  switch (action) {
    case "run":
      if (!input.scenario) throw new Error("action 'run' needs 'scenario' (use action 'list' to see the installed scenarios).");
      return {
        scenarioName: input.scenario,
        iterations: input.iterations ?? 0,
        label: input.label ?? "",
        runContext: input.runContext ?? "",
        markAsBaseline: input.markAsBaseline ?? false,
        tolerancePct: input.tolerancePct ?? 0,
      };
    case "list":
      return {};
    case "setBaseline":
      if (!input.entryNo) throw new Error("action 'setBaseline' needs 'entryNo'.");
      return { entryNo: input.entryNo };
    case "compare":
      if (!input.entryNo) throw new Error("action 'compare' needs 'entryNo'.");
      return { entryNo: input.entryNo, baseEntryNo: input.baseEntryNo ?? 0 };
    default:
      return {};
  }
}

/**
 * Turns a toolkit document into the tool result. A run passes the gate only
 * with status Passed; every other status (Regressed, BudgetExceeded, Failed,
 * Refused, InvalidInput) fails it.
 */
export function summarize(action: string, doc: any, warnings: string[], optIn?: { wasAllowed: boolean; allowed: boolean }): RunPerfResult {
  const r = summarizeRaw(action, doc, warnings, optIn);
  return { ...r, message: r.message.replace(/\.+$/, ".") };
}

function summarizeRaw(action: string, doc: any, warnings: string[], optIn?: { wasAllowed: boolean; allowed: boolean }): RunPerfResult {
  const status: string | undefined = doc?.status;
  if (action === "list") {
    const count = Array.isArray(doc?.scenarios) ? doc.scenarios.length : 0;
    const allowed = doc?.executionAllowed === true;
    return {
      succeeded: true, action, optIn, document: doc, warnings,
      message: `${count} scenario(s) installed; execution ${allowed ? "allowed" : `NOT allowed (${doc?.reason ?? "no reason given"})`}.`,
    };
  }
  if (action === "run") {
    const gate = status === "Passed" ? "pass" : "fail";
    const sql = doc?.stats?.sqlStatements;
    const base = doc?.baseline;
    const detail = status === "Refused" || status === "InvalidInput" || status === "Failed"
      ? ` - ${doc?.error?.message ?? "no error text"}`
      : ` - SQL median ${sql?.median ?? "?"} / max ${sql?.max ?? "?"}${base ? `, vs baseline #${base.entryNo}: ${base.regressed ? "REGRESSED" : "not regressed"}` : ", no baseline"}`;
    return {
      succeeded: status !== undefined && status !== "Refused" && status !== "InvalidInput",
      action, gate, optIn, document: doc, warnings,
      message: `Run ${doc?.entryNo ? `#${doc.entryNo} ` : ""}of '${doc?.scenario ?? "?"}': ${status ?? "no status"}${detail}.`,
    };
  }
  const ok = status !== "InvalidInput" && status !== "Refused" && status !== "Failed";
  const extra = action === "compare" && ok ? ` - regressed: ${doc?.regressed === true}` : "";
  return {
    succeeded: ok, action, optIn, document: doc, warnings,
    message: `${action}: ${status ?? "no status"}${ok ? extra : ` - ${typeof doc?.error === "string" ? doc.error : "rejected"}`}.`,
  };
}

export function createRunPerf(primaryWorkspace: string) {
  return async (input: RunPerfInputT, signal?: AbortSignal): Promise<RunPerfResult> => {
    const warnings: string[] = [];
    const action = input.action ?? "run";
    const params = buildParams(input);
    const projectPath = resolve(input.projectPath ?? primaryWorkspace);
    const cfg = readLaunchConfig(projectPath, input.launchConfig);
    const serverUrl = normalizeServerUrl(cfg.server, cfg.port);
    if (serverUrl.protocol === "http:") warnings.push("launch.json server URL uses plain HTTP - credentials will travel unencrypted.");
    const creds = loadCredentials(serverUrl.origin, cfg.serverInstance);
    const company = input.company ?? cfg.startupCompany ?? "";
    if (!company) throw new Error("No company: pass 'company' or set startupCompany in launch.json.");
    const allowInvalidCert = input.allowInvalidCert === true || process.env.BC_ALLOW_INVALID_CERT === "1" || cfg.validateServerCertificate === false;
    const apiInstance = deriveApiInstance(cfg.serverInstance);
    const lockKey = `${serverUrl.origin.toLowerCase()}|${cfg.serverInstance.toLowerCase()}|${cfg.tenant ?? ""}`;

    return withHubLock(lockKey, loadTimeouts().perfRunMs, async () => {
      try {
        let optIn: { wasAllowed: boolean; allowed: boolean } | undefined;
        if (action === "optIn" || input.ensureOptIn === true) {
          const companyId = await getCompanyId(serverUrl, apiInstance, cfg.tenant, company, creds, allowInvalidCert);
          optIn = await ensureOnPremOptIn(serverUrl, apiInstance, cfg.tenant, companyId, creds, allowInvalidCert, fetch, signal);
          if (!optIn.allowed) warnings.push("allowOnPremRuns could not be set (the PATCH did not take); runs on this on-prem company will be refused.");
          if (action === "optIn") {
            return {
              succeeded: optIn.allowed, action, optIn, warnings,
              message: optIn.wasAllowed ? `On-prem runs were already allowed in '${company}'.` : `On-prem runs are now allowed in '${company}'.`,
            };
          }
        }
        const doc = await callPerfProcedure(serverUrl, apiInstance, cfg.tenant, company, PROCEDURES[action], params, creds, allowInvalidCert, fetch, signal);
        return summarize(action, doc, warnings, optIn);
      } catch (err) {
        throw new Error(redact(err instanceof Error ? err.message : String(err)));
      }
    });
  };
}

/**
 * SOCITAS Performance Toolkit client. The toolkit app registers the codeunit
 * web service `PerfToolkitSOC`; its unbound actions are called as
 * `POST /<instance>/ODataV4/PerfToolkitSOC_<Procedure>?company=<name>` with a
 * JSON body of the procedure's parameters and return `{"value":"<json text>"}`.
 * The on-prem opt-in lives on the API page
 * `/<instance>/api/socitas/performance/v1.0/companies(<id>)/perfSetups`.
 */

import { Credentials, redact } from "./connection.js";

export const PERF_SERVICE = "PerfToolkitSOC";

export type PerfProcedure = "RunScenario" | "ListScenarios" | "SetBaseline" | "CompareRuns";

function auth(creds: Credentials): string {
  return "Basic " + Buffer.from(`${creds.username}:${creds.password}`, "utf8").toString("base64");
}

function withTenant(u: URL, tenant: string | undefined): void {
  if (tenant) u.searchParams.set("tenant", tenant);
}

async function send(
  url: string, method: string, body: unknown, creds: Credentials, allowInvalidCert: boolean,
  fetchFn: typeof fetch, signal?: AbortSignal, extraHeaders: Record<string, string> = {},
): Promise<any> {
  if (allowInvalidCert) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const res = await fetchFn(url, {
    method,
    signal,
    headers: { Authorization: auth(creds), Accept: "application/json", "Content-Type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message ?? ""; } catch { /* body is not JSON */ }
    throw new Error(redact(`Performance Toolkit ${res.status} for ${url.split("?")[0]}${detail ? `: ${detail}` : ""}`));
  }
  return res.status === 204 ? {} : res.json();
}

/**
 * Calls one toolkit web-service procedure and returns its document parsed
 * from the OData `value` string.
 */
export async function callPerfProcedure(
  baseUrl: URL, instance: string, tenant: string | undefined, companyName: string,
  procedure: PerfProcedure, params: Record<string, unknown>,
  creds: Credentials, allowInvalidCert: boolean,
  fetchFn: typeof fetch = fetch, signal?: AbortSignal,
): Promise<any> {
  const u = new URL(baseUrl.toString());
  u.pathname = `/${instance}/ODataV4/${PERF_SERVICE}_${procedure}`;
  u.searchParams.set("company", companyName);
  withTenant(u, tenant);
  const data = await send(u.toString(), "POST", params, creds, allowInvalidCert, fetchFn, signal);
  const raw = data?.value;
  if (typeof raw !== "string") throw new Error(`${PERF_SERVICE}_${procedure} returned no document (is the SOCITAS Performance Toolkit installed?).`);
  return JSON.parse(raw);
}

/**
 * Sets `allowOnPremRuns` on the toolkit setup of a company. Returns the value
 * before the call so the caller can report whether anything changed.
 */
export async function ensureOnPremOptIn(
  baseUrl: URL, instance: string, tenant: string | undefined, companyId: string,
  creds: Credentials, allowInvalidCert: boolean,
  fetchFn: typeof fetch = fetch, signal?: AbortSignal,
): Promise<{ wasAllowed: boolean; allowed: boolean }> {
  const u = new URL(baseUrl.toString());
  u.pathname = `/${instance}/api/socitas/performance/v1.0/companies(${companyId})/perfSetups`;
  withTenant(u, tenant);
  const list = await send(u.toString(), "GET", undefined, creds, allowInvalidCert, fetchFn, signal);
  const row = list?.value?.[0];
  if (!row?.id) throw new Error("The toolkit setup row is missing in this company (reinstall or upgrade the SOCITAS Performance Toolkit).");
  if (row.allowOnPremRuns === true) return { wasAllowed: true, allowed: true };
  const p = new URL(baseUrl.toString());
  p.pathname = `/${instance}/api/socitas/performance/v1.0/companies(${companyId})/perfSetups(${row.id})`;
  withTenant(p, tenant);
  const patched = await send(p.toString(), "PATCH", { allowOnPremRuns: true }, creds, allowInvalidCert, fetchFn, signal, { "If-Match": "*" });
  return { wasAllowed: false, allowed: patched?.allowOnPremRuns === true };
}

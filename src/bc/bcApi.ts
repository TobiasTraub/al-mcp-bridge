/**
 * Performance Toolkit API client: reads BCPT log entries and resolves a
 * company id over the shipped BC API (`api/v2.0/companies` and the
 * `api/microsoft/performancToolkit/v1.0` extension). Lifted alongside
 * `connection.ts` so `al_run_bcpt` can drive a BCPT suite over the standard
 * API instead of scraping the client-service UI.
 */

import { Credentials, redact } from "./connection.js";

export type RawLogEntry = {
  bcptCode: string; bcptLineNo: number; codeunitId: number; codeunitName: string;
  durationMs: number; noOfSqlStatements: number; operation: string;
  status: string; startTime: string;
};

function auth(creds: Credentials): string {
  return "Basic " + Buffer.from(`${creds.username}:${creds.password}`, "utf8").toString("base64");
}

async function getJson(url: string, creds: Credentials, allowInvalidCert: boolean, fetchFn: typeof fetch = fetch): Promise<any> {
  if (allowInvalidCert) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const res = await fetchFn(url, { headers: { Authorization: auth(creds), Accept: "application/json" } });
  if (!res.ok) throw new Error(redact(`BCPT API ${res.status} for ${url.split("?")[0]}`));
  return res.json();
}

export async function getCompanyId(
  baseUrl: URL, instance: string, tenant: string | undefined,
  companyName: string, creds: Credentials, allowInvalidCert: boolean,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const u = new URL(baseUrl.toString());
  u.pathname = `/${instance}/api/v2.0/companies`;
  if (tenant) u.searchParams.set("tenant", tenant);
  const base = u.toString();
  const sep = base.includes("?") ? "&" : "?";
  const filter = encodeURIComponent(`name eq '${companyName.replace(/'/g, "''")}'`);
  const data = await getJson(`${base}${sep}$filter=${filter}`, creds, allowInvalidCert, fetchFn);
  const first = data?.value?.[0];
  if (!first?.id) throw new Error(`No company id for '${companyName}'.`);
  return first.id as string;
}

export async function getBcptLogEntries(
  baseUrl: URL, instance: string, tenant: string | undefined,
  companyId: string, suiteCode: string, sinceIso: string | undefined,
  creds: Credentials, allowInvalidCert: boolean,
  fetchFn: typeof fetch = fetch,
): Promise<RawLogEntry[]> {
  const u = new URL(baseUrl.toString());
  u.pathname = `/${instance}/api/microsoft/performancToolkit/v1.0/companies(${companyId})/bcptLogEntries`;
  if (tenant) u.searchParams.set("tenant", tenant);
  const base = u.toString();
  const sep = base.includes("?") ? "&" : "?";
  const clauses = [`bcptCode eq '${suiteCode.replace(/'/g, "''")}'`];
  if (sinceIso) clauses.push(`startTime ge ${sinceIso}`);
  const filter = encodeURIComponent(clauses.join(" and "));
  const url = `${base}${sep}$filter=${filter}`;
  const data = await getJson(url, creds, allowInvalidCert, fetchFn);
  return (data?.value ?? []).map((r: any): RawLogEntry => ({
    bcptCode: r.bcptCode,
    bcptLineNo: r.lineNumber,
    codeunitId: r.codeunitID,
    codeunitName: r.codeunitName,
    durationMs: r.durationMin ?? 0,
    noOfSqlStatements: r.numberOfSQLStmts ?? 0,
    operation: r.operation,
    status: r.status,
    startTime: r.startTime,
  }));
}

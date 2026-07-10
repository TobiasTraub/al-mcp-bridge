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

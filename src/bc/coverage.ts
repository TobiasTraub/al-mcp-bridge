/**
 * Procedure-level code coverage for al_run_tests.
 *
 * The dev-endpoint TestRunnerHub reports coverage in `TestRunCompleted` as
 * `{ Tests: [{ MethodId, ApplicationObjectId, OwningApp, CoveredProcedures:
 * [{ ObjectType, ObjectId, MethodId }] }] }`. Line mode (coverageMode=1)
 * returns the same procedure-level data, so procedure mode is all we ask for.
 *
 * `MethodId` is the compiler's member id — a hash over name, return type and
 * parameter types that has changed across runtime versions. We deliberately do
 * NOT reimplement it. Names come only from the exact ids a compiled `.app`
 * carries in its SymbolReference.json, which lists public and internal
 * procedures. Local procedures, triggers and event subscribers are absent
 * there; they are counted per object (`unmappedExecuted`), never named.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Hub payload
// ---------------------------------------------------------------------------

export interface RawCoveredProcedure {
  ObjectType: number;
  ObjectId: number;
  MethodId: number;
}

export interface RawTestCoverage {
  MethodId: number;
  ApplicationObjectId: number;
  OwningApp?: string;
  CoveredProcedures?: RawCoveredProcedure[];
}

export interface RawCoveragePayload {
  Tests?: RawTestCoverage[];
}

/** Runtime object type numbers as the hub sends them (AllObj "Object Type"). */
export const OBJECT_TYPE_NAMES: Record<number, string> = {
  1: "Table",
  3: "Report",
  5: "Codeunit",
  6: "XmlPort",
  8: "Page",
  9: "Query",
  14: "PageExtension",
  15: "TableExtension",
  22: "ReportExtension",
};

/** SymbolReference.json collection → runtime object type. */
const SYMBOL_COLLECTIONS: Array<[string, number]> = [
  ["Tables", 1],
  ["Reports", 3],
  ["Codeunits", 5],
  ["XmlPorts", 6],
  ["Pages", 8],
  ["Queries", 9],
  ["PageExtensions", 14],
  ["TableExtensions", 15],
  ["ReportExtensions", 22],
];

/** AL source keyword → runtime object type. */
const SOURCE_KEYWORDS: Record<string, number> = {
  table: 1,
  report: 3,
  codeunit: 5,
  xmlport: 6,
  page: 8,
  query: 9,
  pageextension: 14,
  tableextension: 15,
  reportextension: 22,
};

export function objectKey(objectType: number, objectId: number): string {
  return `${objectType}:${objectId}`;
}

// ---------------------------------------------------------------------------
// Symbols from a compiled .app
// ---------------------------------------------------------------------------

export interface SymbolObject {
  objectType: number;
  objectId: number;
  name: string;
  /** member id → display name (overloads carry their parameter types). */
  methods: Map<number, string>;
}

export interface AppSymbols {
  appName: string;
  appPath: string;
  objects: Map<string, SymbolObject>;
}

/**
 * Resolve an `.app` from a path that is either the file itself or an AL
 * project folder (newest top-level `*.app` wins — the compile output).
 */
export function resolveAppFile(pathOrProject: string): string {
  if (!existsSync(pathOrProject)) {
    throw new Error(`coverageApps entry not found: ${pathOrProject}`);
  }
  if (statSync(pathOrProject).isFile()) return pathOrProject;
  const apps = readdirSync(pathOrProject)
    .filter((f) => extname(f).toLowerCase() === ".app")
    .map((f) => join(pathOrProject, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (apps.length === 0) {
    throw new Error(
      `No .app in ${pathOrProject} — compile the project first (al_compile with generateCode: true).`,
    );
  }
  return apps[0];
}

/**
 * The newest `.al` source under an AL project folder that is younger than its
 * resolved `.app`, or undefined. A stale `.app` lacks new procedures and test
 * methods, so their ids stay unnamed (`<codeunit>#<id>`) without any error.
 */
export function newerSourceThanApp(projectDir: string, appPath: string): string | undefined {
  if (!statSync(projectDir).isDirectory()) return undefined;
  const appTime = statSync(appPath).mtimeMs;
  let newest: { path: string; time: number } | undefined;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extname(entry.name).toLowerCase() === ".al") {
        const time = statSync(full).mtimeMs;
        if (time > appTime && (!newest || time > newest.time)) newest = { path: full, time };
      }
    }
  };
  walk(projectDir);
  return newest?.path;
}

export function loadAppSymbols(pathOrProject: string): AppSymbols {
  const appPath = resolveAppFile(pathOrProject);
  const raw = readZipEntry(readFileSync(appPath), "SymbolReference.json");
  if (!raw) throw new Error(`${appPath} has no SymbolReference.json.`);
  const json = JSON.parse(raw.toString("utf8").replace(/^﻿/, "")) as SymbolNamespace & {
    Name?: string;
  };
  const objects = new Map<string, SymbolObject>();
  collectObjects(json, objects);
  return { appName: json.Name ?? appPath, appPath, objects };
}

interface SymbolMethod {
  Id?: number;
  Name?: string;
  Parameters?: Array<{ Name?: string; TypeDefinition?: { Name?: string } }>;
}

interface SymbolNamespace {
  Namespaces?: SymbolNamespace[];
  [collection: string]: unknown;
}

function collectObjects(ns: SymbolNamespace, out: Map<string, SymbolObject>): void {
  for (const [collection, objectType] of SYMBOL_COLLECTIONS) {
    const list = ns[collection];
    if (!Array.isArray(list)) continue;
    for (const o of list as Array<{ Id?: number; Name?: string; Methods?: SymbolMethod[] }>) {
      if (typeof o.Id !== "number") continue;
      out.set(objectKey(objectType, o.Id), {
        objectType,
        objectId: o.Id,
        name: o.Name ?? "",
        methods: methodNames(o.Methods ?? []),
      });
    }
  }
  for (const child of ns.Namespaces ?? []) collectObjects(child, out);
}

function methodNames(methods: SymbolMethod[]): Map<number, string> {
  const counts = new Map<string, number>();
  for (const m of methods) if (m.Name) counts.set(m.Name, (counts.get(m.Name) ?? 0) + 1);
  const out = new Map<number, string>();
  for (const m of methods) {
    if (typeof m.Id !== "number" || !m.Name) continue;
    const overloaded = (counts.get(m.Name) ?? 0) > 1;
    const params = (m.Parameters ?? []).map((p) => p.TypeDefinition?.Name ?? "?").join(", ");
    out.set(m.Id, overloaded ? `${m.Name}(${params})` : m.Name);
  }
  return out;
}

/**
 * Minimal zip reader for the one entry we need. A BC `.app` is a 40-byte
 * NAVX header followed by a plain zip, so offsets are taken relative to the
 * first local-file signature.
 */
export function readZipEntry(file: Buffer, entryName: string): Buffer | undefined {
  const zipStart = file.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (zipStart < 0) return undefined;
  const zip = file.subarray(zipStart);

  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;

  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return undefined;
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === entryName) {
      const lNameLen = zip.readUInt16LE(localOffset + 26);
      const lExtraLen = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`Unsupported zip compression method ${method} for ${entryName}.`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Objects declared in AL source files
// ---------------------------------------------------------------------------

export interface DeclaredObject {
  objectType: number;
  objectId: number;
  name: string;
  file: string;
}

const OBJECT_HEADER =
  /^\s*(tableextension|pageextension|reportextension|table|codeunit|page|report|query|xmlport)\s+(\d+)\s+("[^"]+"|[A-Za-z_][\w]*)/gim;

export function declaredObjects(file: string, source?: string): DeclaredObject[] {
  const text = source ?? readFileSync(file, "utf8");
  const out: DeclaredObject[] = [];
  for (const m of text.matchAll(OBJECT_HEADER)) {
    out.push({
      objectType: SOURCE_KEYWORDS[m[1].toLowerCase()],
      objectId: Number(m[2]),
      name: m[3].replace(/^"|"$/g, ""),
      file,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ObjectCoverage {
  objectType: string;
  objectId: number;
  name: string;
  /** False when no test executed any procedure of this object. */
  entered: boolean;
  /** Public/internal procedures executed, with the tests that reached them. */
  coveredProcedures: Array<{ name: string; coveredBy: string[] }>;
  /** Public/internal procedures no test executed. */
  uncoveredProcedures: string[];
  /** Executed procedures with no name in the symbols: locals, triggers, event subscribers. */
  unmappedExecuted: number;
}

export interface CoverageReport {
  scope: string;
  testsWithCoverage: number;
  /** Touched objects (coverageFiles) or, without them, every entered object of the mapped apps. */
  objects: ObjectCoverage[];
  /** Objects outside the mapped apps that the tests entered (base app, libraries). */
  otherObjectsEntered: number;
  mappedApps: string[];
  warnings: string[];
}

export const COVERAGE_SCOPE =
  "Procedure-level coverage. Names exist only for public/internal procedures (from the app's " +
  "SymbolReference.json); local procedures, triggers and event subscribers are counted in " +
  "unmappedExecuted, never named. An uncovered local procedure is invisible here — absence of " +
  "a name is not proof of coverage. No line coverage.";

const MAX_COVERED_BY = 10;

export function buildCoverageReport(
  payloads: RawCoveragePayload[],
  apps: AppSymbols[],
  touched: DeclaredObject[] | undefined,
  warnings: string[],
): CoverageReport {
  const symbols = new Map<string, SymbolObject>();
  for (const app of apps) for (const [k, v] of app.objects) symbols.set(k, v);

  // objectKey → methodId → test names that executed it
  const executed = new Map<string, Map<number, Set<string>>>();
  let testsWithCoverage = 0;
  for (const payload of payloads) {
    for (const t of payload.Tests ?? []) {
      testsWithCoverage++;
      const testName = testDisplayName(t, symbols);
      for (const p of t.CoveredProcedures ?? []) {
        const key = objectKey(p.ObjectType, p.ObjectId);
        let byMethod = executed.get(key);
        if (!byMethod) executed.set(key, (byMethod = new Map()));
        let tests = byMethod.get(p.MethodId);
        if (!tests) byMethod.set(p.MethodId, (tests = new Set()));
        tests.add(testName);
      }
    }
  }

  const testCodeunits = new Set<string>();
  for (const payload of payloads)
    for (const t of payload.Tests ?? []) testCodeunits.add(objectKey(5, t.ApplicationObjectId));

  let targets: Array<{ objectType: number; objectId: number; name: string }>;
  if (touched && touched.length > 0) {
    const seen = new Set<string>();
    targets = [];
    for (const d of touched) {
      const key = objectKey(d.objectType, d.objectId);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(d);
      if (!symbols.has(key)) {
        warnings.push(
          `${OBJECT_TYPE_NAMES[d.objectType] ?? d.objectType} ${d.objectId} "${d.name}" is not in the mapped apps' symbols — ` +
            `add its project to coverageApps (and recompile it) to get procedure names.`,
        );
      }
    }
  } else {
    targets = [...executed.keys()]
      .filter((k) => symbols.has(k) && !testCodeunits.has(k))
      .map((k) => symbols.get(k)!);
  }

  const objects: ObjectCoverage[] = targets.map((t) => {
    const key = objectKey(t.objectType, t.objectId);
    const sym = symbols.get(key);
    const byMethod = executed.get(key) ?? new Map<number, Set<string>>();
    const covered: ObjectCoverage["coveredProcedures"] = [];
    const uncovered: string[] = [];
    if (sym) {
      for (const [id, name] of sym.methods) {
        const tests = byMethod.get(id);
        if (tests) covered.push({ name, coveredBy: [...tests].sort().slice(0, MAX_COVERED_BY) });
        else uncovered.push(name);
      }
    }
    let unmapped = 0;
    for (const id of byMethod.keys()) if (!sym?.methods.has(id)) unmapped++;
    return {
      objectType: OBJECT_TYPE_NAMES[t.objectType] ?? String(t.objectType),
      objectId: t.objectId,
      name: sym?.name ?? t.name,
      entered: byMethod.size > 0,
      coveredProcedures: covered.sort((a, b) => a.name.localeCompare(b.name)),
      uncoveredProcedures: uncovered.sort(),
      unmappedExecuted: unmapped,
    };
  });

  let otherObjectsEntered = 0;
  for (const k of executed.keys()) if (!symbols.has(k)) otherObjectsEntered++;

  return {
    scope: COVERAGE_SCOPE,
    testsWithCoverage,
    objects,
    otherObjectsEntered,
    mappedApps: apps.map((a) => a.appName),
    warnings,
  };
}

function testDisplayName(t: RawTestCoverage, symbols: Map<string, SymbolObject>): string {
  const cu = symbols.get(objectKey(5, t.ApplicationObjectId));
  const method = cu?.methods.get(t.MethodId);
  return method ? `${t.ApplicationObjectId}.${method}` : `${t.ApplicationObjectId}#${t.MethodId}`;
}

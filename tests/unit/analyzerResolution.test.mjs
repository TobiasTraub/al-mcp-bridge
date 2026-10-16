/**
 * Unit coverage for analyzer resolution from `.vscode/settings.json`.
 *
 * Regression: from AL 18 on the extension has no `bin/Analyzers` folder - the
 * cops sit directly in `bin`. The bridge only looked for `bin/Analyzers`, so
 * `${CodeCop}`, `${AppSourceCop}`, `${analyzerFolder}…LinterCop.dll` etc. all
 * resolved to nothing and were dropped with only a stderr line. A compile gate
 * then ran with just the AL_EXTRA_CODE_ANALYZERS extras and still said "clean".
 * Configured analyzers that can't be loaded must now be reported, and the
 * deprecated SocitasCop v1 / ReviewerCop must be skipped visibly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deriveAnalyzerFolder, resolveWorkspaceSettings } from "../../dist/config.js";

const MS_COPS = [
  "Microsoft.Dynamics.Nav.AppSourceCop.dll",
  "Microsoft.Dynamics.Nav.CodeCop.dll",
  "Microsoft.Dynamics.Nav.PerTenantExtensionCop.dll",
  "Microsoft.Dynamics.Nav.UICop.dll",
];

/** Fake AL extension. `layout`: "al17" = cops in bin/Analyzers, "al18" = cops in bin. */
function makeExtension(root, layout, extraDlls = []) {
  const bin = join(root, "bin");
  const win32 = join(bin, "win32");
  mkdirSync(win32, { recursive: true });
  const ls = join(win32, "Microsoft.Dynamics.Nav.EditorServices.Host.exe");
  writeFileSync(ls, "");
  const copDir = layout === "al17" ? join(bin, "Analyzers") : bin;
  mkdirSync(copDir, { recursive: true });
  for (const f of [...MS_COPS, ...extraDlls]) writeFileSync(join(copDir, f), "");
  return { ls, copDir };
}

function makeWorkspace(root, analyzers) {
  const ws = join(root, "app");
  mkdirSync(join(ws, ".vscode"), { recursive: true });
  writeFileSync(join(ws, "app.json"), "{}");
  writeFileSync(join(ws, ".vscode", "settings.json"), JSON.stringify({ "al.codeAnalyzers": analyzers }));
  return ws;
}

const GC_STYLE = [
  "${AppSourceCop}",
  "${CodeCop}",
  "${PerTenantExtensionCop}",
  "${UICop}",
  "${analyzerFolder}BusinessCentral.LinterCop.dll",
  "${analyzerFolder}BusinessCentral.SocitasCop.dll",
];

function withEnv(value, fn) {
  const prev = process.env.AL_EXTRA_CODE_ANALYZERS;
  if (value === undefined) delete process.env.AL_EXTRA_CODE_ANALYZERS;
  else process.env.AL_EXTRA_CODE_ANALYZERS = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AL_EXTRA_CODE_ANALYZERS;
    else process.env.AL_EXTRA_CODE_ANALYZERS = prev;
  }
}

test("deriveAnalyzerFolder: AL 17 layout -> bin/Analyzers", () => {
  const root = mkdtempSync(join(tmpdir(), "albridge-af17-"));
  try {
    const { ls, copDir } = makeExtension(root, "al17");
    assert.equal(deriveAnalyzerFolder(ls), copDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveAnalyzerFolder: AL 18 layout (no Analyzers folder) -> bin", () => {
  const root = mkdtempSync(join(tmpdir(), "albridge-af18-"));
  try {
    const { ls, copDir } = makeExtension(root, "al18");
    assert.equal(deriveAnalyzerFolder(ls), copDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AL 18: Microsoft cops + LinterCop resolve from bin; SocitasCop v1 is skipped as deprecated", () => {
  const root = mkdtempSync(join(tmpdir(), "albridge-ws18-"));
  try {
    const { ls } = makeExtension(join(root, "ext"), "al18", ["BusinessCentral.LinterCop.dll", "BusinessCentral.SocitasCop.dll"]);
    const ws = makeWorkspace(root, GC_STYLE);
    const s = withEnv(undefined, () => resolveWorkspaceSettings(ws, ls));
    const loaded = s.codeAnalyzers.map((p) => basename(p));
    for (const cop of [...MS_COPS, "BusinessCentral.LinterCop.dll"]) assert.ok(loaded.includes(cop), `${cop} loaded`);
    assert.ok(!loaded.includes("BusinessCentral.SocitasCop.dll"), "v1 not loaded");
    assert.deepEqual(
      s.skippedAnalyzers.map((x) => [basename(x.resolved), x.reason]),
      [["BusinessCentral.SocitasCop.dll", "deprecated"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a configured analyzer that does not exist is reported as not-found, not dropped silently", () => {
  const root = mkdtempSync(join(tmpdir(), "albridge-nf-"));
  try {
    const { ls } = makeExtension(join(root, "ext"), "al18");
    const ws = makeWorkspace(root, ["${CodeCop}", "${analyzerFolder}BusinessCentral.LinterCop.dll"]);
    const s = withEnv(undefined, () => resolveWorkspaceSettings(ws, ls));
    assert.deepEqual(s.skippedAnalyzers.map((x) => [x.entry, x.reason]), [
      ["${analyzerFolder}BusinessCentral.LinterCop.dll", "not-found"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no analyzer folder at all -> placeholder entries are reported as unresolved", () => {
  const root = mkdtempSync(join(tmpdir(), "albridge-none-"));
  try {
    const bin = join(root, "ext", "bin", "win32");
    mkdirSync(bin, { recursive: true });
    const ls = join(bin, "Microsoft.Dynamics.Nav.EditorServices.Host.exe");
    writeFileSync(ls, "");
    const ws = makeWorkspace(root, ["${CodeCop}", "${analyzerFolder}BusinessCentral.LinterCop.dll"]);
    const s = withEnv(undefined, () => resolveWorkspaceSettings(ws, ls));
    assert.equal(s.codeAnalyzers.length, 0);
    assert.deepEqual(s.skippedAnalyzers.map((x) => x.reason), ["unresolved-placeholder", "unresolved-placeholder"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deprecated ReviewerCop via AL_EXTRA_CODE_ANALYZERS is skipped and reported", () => {
  const root = mkdtempSync(join(tmpdir(), "albridge-rc-"));
  try {
    const { ls, copDir } = makeExtension(join(root, "ext"), "al18", ["Socitas.ReviewerCop.dll", "Socitas.AiCop.dll"]);
    const ws = makeWorkspace(root, ["${CodeCop}"]);
    const extra = [join(copDir, "Socitas.ReviewerCop.dll"), join(copDir, "Socitas.AiCop.dll")].join(";");
    const s = withEnv(extra, () => resolveWorkspaceSettings(ws, ls));
    const loaded = s.codeAnalyzers.map((p) => basename(p));
    assert.ok(loaded.includes("Socitas.AiCop.dll"));
    assert.ok(!loaded.includes("Socitas.ReviewerCop.dll"));
    assert.deepEqual(s.skippedAnalyzers.map((x) => x.reason), ["deprecated"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Shared Business Central dev-service connection helpers: launch.json
 * parsing, credential loading, server URL normalization, the per-hub
 * single-flight lock, and error redaction. Lifted out of `runTests.ts` so a
 * second tool (e.g. al_run_bcpt) can reuse them without duplicating the
 * credential-security and launch.json parsing logic.
 *
 * Credential security:
 *   - Read-only. This module never writes credentials to disk.
 *   - Env vars `BC_USER` + `BC_PASSWORD` take precedence.
 *   - File fallback at `$XDG_CONFIG_HOME/al-mcp-bridge/credentials.json`
 *     (default `~/.config/...`); file must be mode 0600 — stricter is fine,
 *     any group/world-readable bit causes a hard refusal.
 *   - Password is never logged, never returned in the MCP response, and
 *     scrubbed from error strings before they leave this module.
 */

import { constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown for user-facing config problems where echoing the error message to
 * the MCP response is safe. Catchers must still run the message through
 * `redact()` in case a URL or header slipped in.
 */
export class BcConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BcConnectionError";
  }
}

// ---------------------------------------------------------------------------
// Per-hub single-flight lock
// ---------------------------------------------------------------------------

/**
 * The BC dev-service test-runner hub serializes test execution server-side:
 * a second connection that calls `Initialize` while another run is still
 * holding the test session fails with a generic "An unexpected error
 * occurred invoking 'Initialize' on the server." SignalR error. To prevent
 * parallel MCP calls against the same server from tripping this, we queue
 * runs per `{server}|{instance}|{tenant}` key.
 *
 * Keyed map lives at module scope so multiple tool invocations share it.
 */
const hubLocks = new Map<string, Promise<void>>();

export async function withHubLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = hubLocks.get(key) ?? Promise.resolve();
  // Build the settled slot once so we can compare identities on cleanup.
  let settle!: () => void;
  const slot = new Promise<void>((r) => {
    settle = r;
  });
  hubLocks.set(key, slot);
  try {
    await prev; // wait for the previous run on this hub to finish
    return await fn();
  } finally {
    settle();
    // If nobody else has claimed the slot since, drop the entry so the
    // map doesn't leak keys for one-shot hubs.
    if (hubLocks.get(key) === slot) hubLocks.delete(key);
  }
}

// ---------------------------------------------------------------------------
// launch.json parsing
// ---------------------------------------------------------------------------

export interface LaunchConfig {
  name: string;
  server: string;
  serverInstance: string;
  port?: number;
  tenant?: string;
  authentication?: string;
  environmentType?: string;
  startupCompany?: string;
  validateServerCertificate?: boolean;
}

export function readLaunchConfig(projectPath: string, desiredName?: string): LaunchConfig {
  const launchFile = join(projectPath, ".vscode", "launch.json");
  if (!existsSync(launchFile)) {
    throw new BcConnectionError(`launch.json not found at ${launchFile}.`);
  }
  const raw = readFileSync(launchFile, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (err) {
    throw new BcConnectionError(
      `Could not parse launch.json: ${(err as Error).message}`,
    );
  }
  const configs = (parsed as { configurations?: unknown[] })?.configurations;
  if (!Array.isArray(configs) || configs.length === 0) {
    throw new BcConnectionError(`launch.json has no 'configurations' array.`);
  }

  const chosen = desiredName
    ? (configs as Array<Record<string, unknown>>).find(
        (c) => typeof c.name === "string" && c.name === desiredName,
      )
    : (configs[0] as Record<string, unknown>);

  if (!chosen) {
    throw new BcConnectionError(
      `No launch configuration named '${desiredName}' in ${launchFile}.`,
    );
  }

  const server = readString(chosen, "server");
  const serverInstance = readString(chosen, "serverInstance");
  if (!server || !serverInstance) {
    throw new BcConnectionError(
      `launch configuration '${String(chosen.name)}' is missing 'server' or 'serverInstance'.`,
    );
  }

  return {
    name: String(chosen.name ?? "(unnamed)"),
    server,
    serverInstance,
    port: typeof chosen.port === "number" ? chosen.port : undefined,
    tenant: readString(chosen, "tenant"),
    authentication: readString(chosen, "authentication"),
    environmentType: readString(chosen, "environmentType"),
    startupCompany: readString(chosen, "startupCompany"),
    validateServerCertificate:
      typeof chosen.validateServerCertificate === "boolean"
        ? (chosen.validateServerCertificate as boolean)
        : undefined,
  };
}

function readString(
  o: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = o[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/[^\n\r]*/g, "$1");
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

export function normalizeServerUrl(server: string, port?: number): URL {
  let raw = server.trim();
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  const u = new URL(raw);
  if (port !== undefined && port !== null) u.port = String(port);
  return u;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface Credentials {
  username: string;
  password: string;
}

export function loadCredentials(origin: string, serverInstance: string): Credentials {
  // 1. Env vars — preferred for ephemeral sessions.
  const envUser = process.env.BC_USER?.trim();
  const envPwd = process.env.BC_PASSWORD;
  if (envUser && envPwd) {
    return { username: envUser, password: envPwd };
  }

  // 2. File fallback — strict-mode check.
  const cfgBase =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
      ? process.env.XDG_CONFIG_HOME.trim()
      : join(homedir(), ".config");
  const credFile = join(cfgBase, "al-mcp-bridge", "credentials.json");

  if (!existsSync(credFile)) {
    throw new BcConnectionError(
      `No credentials available. Set BC_USER and BC_PASSWORD env vars, or create ${credFile} (mode 0600) with { "<server>|<instance>": { "username": "...", "password": "..." } }.`,
    );
  }

  // Enforce mode 0600: owner rw only, no group/other bits.
  // `S_IRWXG | S_IRWXO` covers group read/write/execute + other read/write/execute.
  // Also reject if the file is not a regular file.
  const st = statSync(credFile);
  if (!st.isFile()) {
    throw new BcConnectionError(
      `Credentials path exists but is not a regular file: ${credFile}.`,
    );
  }
  const unsafeBits =
    st.mode & (constants.S_IRWXG | constants.S_IRWXO);
  if (unsafeBits !== 0) {
    throw new BcConnectionError(
      `Credentials file ${credFile} has permissions ${(st.mode & 0o777).toString(8)}. Refusing to read — chmod 600 ${credFile}.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(credFile, "utf8"));
  } catch (err) {
    throw new BcConnectionError(
      `Could not parse credentials file: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new BcConnectionError(`Credentials file must be a JSON object.`);
  }

  // Try key variants, most specific first. Users are likely to write
  // credentials against the hostname without the dev-service port, so we
  // accept both. Scheme can also be dropped (some users key by host alone).
  const instanceLower = serverInstance.toLowerCase();
  const originUrl = new URL(origin);
  const hostPort = originUrl.host.toLowerCase(); // e.g. docker.socitas.de:56565
  const hostOnly = originUrl.hostname.toLowerCase(); // e.g. docker.socitas.de
  const schemeHostPort = `${originUrl.protocol}//${hostPort}`.toLowerCase();
  const schemeHostOnly = `${originUrl.protocol}//${hostOnly}`.toLowerCase();

  const candidateKeys = [
    // Specific instance first — most targeted wins.
    `${schemeHostPort}|${instanceLower}`,
    `${schemeHostOnly}|${instanceLower}`,
    `${hostPort}|${instanceLower}`,
    `${hostOnly}|${instanceLower}`,
    // legacy `_` separator (matches the MS on-prem credential cache format)
    `${schemeHostPort}_${instanceLower}`,
    `${schemeHostOnly}_${instanceLower}`,
    `${hostPort}_${instanceLower}`,
    `${hostOnly}_${instanceLower}`,
    // Wildcard: one credential covers every instance on the same host. Use
    // when all dev instances on a server share the same admin account.
    `${schemeHostPort}|*`,
    `${schemeHostOnly}|*`,
    `${hostPort}|*`,
    `${hostOnly}|*`,
  ];

  const record = parsed as Record<string, unknown>;
  let entry:
    | { username?: unknown; password?: unknown }
    | undefined;
  for (const k of candidateKeys) {
    const v = record[k];
    if (v && typeof v === "object") {
      entry = v as { username?: unknown; password?: unknown };
      break;
    }
  }

  if (!entry || typeof entry.username !== "string" || typeof entry.password !== "string") {
    throw new BcConnectionError(
      `No credential entry for '${candidateKeys[0]}' (also tried: ${candidateKeys
        .slice(1)
        .map((k) => `'${k}'`)
        .join(
          ", ",
        )}) in credentials file. Expected { "${candidateKeys[0]}": { "username": "...", "password": "..." } }.`,
    );
  }
  return { username: entry.username, password: entry.password };
}

// ---------------------------------------------------------------------------
// Error hygiene — credentials must never leak via error strings
// ---------------------------------------------------------------------------

/**
 * Strip anything that could carry credentials out of an error message:
 *   - any value after `Authorization:` / `Authentication=`
 *   - any `Basic <base64>` / `Bearer <token>` token
 *   - inline `user:pass@host` URLs
 *   - `password` / `pwd` field values in JSON-ish fragments
 *
 * We over-redact on purpose. Users can always re-run with verbose logging to
 * their own trusted sink if they need the original string.
 */
export function redact(s: string): string {
  if (!s) return s;
  let out = s;
  // 1. URL-embedded creds first so later regexes see a cleaner string.
  out = out.replace(/(\bhttps?:\/\/)[^:/\s]+:[^@\s]+@/gi, "$1[redacted]@");
  // 2. Scrub token *values* before header-name rules — otherwise
  //    `Authorization: Basic <base64>` gets split into two redactions and
  //    the base64 tail can slip through.
  out = out.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/g, "$1 [redacted]");
  // 3. URL-encoded auth query params: `Authentication=Basic%20<base64>` (and
  //    any other scheme) — stop at `&`, whitespace, or quote.
  out = out.replace(
    /Authentication\s*=\s*[^\s&"']+/gi,
    "Authentication=[redacted]",
  );
  // 4. Header-style auth. The value may be `[redacted]` by now, which is
  //    fine — we just collapse the whole span.
  out = out.replace(
    /Authorization\s*[:=]\s*[^\s,;&"']+/gi,
    "Authorization: [redacted]",
  );
  // 5. JSON-ish secret fields.
  out = out.replace(
    /("(?:password|pwd|secret|token)"\s*:\s*)"[^"]*"/gi,
    '$1"[redacted]"',
  );
  return out;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    // Don't include stack — it may contain query-string auth copies
    // emitted by some transport libraries.
    return err.message || err.name;
  }
  return String(err);
}

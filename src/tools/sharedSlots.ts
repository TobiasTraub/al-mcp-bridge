/**
 * Machine-wide heavy-job slots shared with the al-runner wrapper (Linux).
 *
 * A slot is the kernel flock on <dir>/slot-<i> (i is 1-based). The wrapper holds it
 * for a test run, the bridge for an alc run; both use the same helper command line,
 * so the lock dies with its holder (SIGKILL included) and needs no stale-age reclaim.
 * Slot files are never deleted or truncated.
 *
 * Node cannot flock(2) directly, so the bridge holds the lock through a helper
 * process: `flock -o -n -E 75 <file> sh -c 'echo held; exec cat >/dev/null'`.
 * Its stdin is a pipe from the bridge: when the bridge dies the pipe closes, `cat`
 * exits and the lock is released.
 */
import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

/** flock -E value that means "lock is held by somebody else". */
export const SLOT_BUSY_EXIT = 75;
/** flock exit for a usage error (option unsupported): kernel locking is unusable. */
const FLOCK_USAGE_EXIT = 64;
/** The helper must answer within this long, else it is killed and the slot counts as busy. */
const HELPER_ANSWER_MS = 5000;

/** Shared lock directory: AL_RUNNER_LOCK_DIR, else /tmp/al-runner-slots-<euid>. */
export function sharedSlotDir(env: NodeJS.ProcessEnv = process.env, euid: number = currentUid()): string {
  const d = env.AL_RUNNER_LOCK_DIR?.trim();
  return d ? d : `/tmp/al-runner-slots-${euid}`;
}

function currentUid(): number {
  return typeof process.geteuid === "function" ? process.geteuid() : 0;
}

/**
 * Create the directory (0700) when missing and check it is safe to hold locks in:
 * a real directory owned by us, not writable by group/other. Returns null when
 * usable, else the reason it is not.
 */
export function checkSharedDir(dir: string, euid: number = currentUid()): string | null {
  try {
    try {
      lstatSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) return `${dir} is a symlink`;
    if (!st.isDirectory()) return `${dir} is not a directory`;
    if (st.uid !== euid) return `${dir} is not owned by uid ${euid}`;
    if ((st.mode & 0o022) !== 0) return `${dir} is group/other-writable`;
    return null;
  } catch (err) {
    return `cannot create or inspect ${dir}: ${(err as Error).message}`;
  }
}

export type HoldResult =
  | { state: "held"; release(): void }
  | { state: "busy"; warning?: string }
  | { state: "unusable"; reason: string; /** true: flock itself is unusable on this machine (cache it) */ global?: boolean };

/** Try once to take the flock on `file` through the helper process. */
export function tryHoldSlot(file: string, flockPath = "flock"): Promise<HoldResult> {
  return new Promise<HoldResult>((resolvePromise) => {
    let settled = false;
    let held = false;
    const child = spawn(
      flockPath,
      ["-o", "-n", "-E", String(SLOT_BUSY_EXIT), file, "sh", "-c", "echo held; exec cat >/dev/null"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    const kill = () => {
      try {
        child.stdin?.destroy();
      } catch {
        // already closed
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const settle = (r: HoldResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(r);
    };
    const timer = setTimeout(() => {
      kill();
      settle({ state: "busy", warning: `flock helper for ${file} gave no answer within ${HELPER_ANSWER_MS / 1000}s` });
    }, HELPER_ANSWER_MS);

    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      if (!held && /^held$/m.test(buf)) {
        held = true;
        settle({
          state: "held",
          release: () => kill(), // idempotent: destroy + SIGKILL of a dead child are no-ops
        });
      }
    });
    child.once("error", (err: NodeJS.ErrnoException) => {
      // Only a missing binary proves flock unusable; EAGAIN/EMFILE/ENOMEM are transient.
      settle(
        err.code === "ENOENT"
          ? { state: "unusable", reason: `flock not found (${flockPath})`, global: true }
          : { state: "busy", warning: `flock helper could not be started (${err.code ?? err.message}); treated as busy this pass` },
      );
    });
    child.once("exit", (code) => {
      if (code === SLOT_BUSY_EXIT) settle({ state: "busy" });
      else if (code === FLOCK_USAGE_EXIT) settle({ state: "unusable", reason: "flock rejected its options (exit 64)", global: true });
      else if (code === null) settle({ state: "busy", warning: `flock helper for ${file} was killed by a signal` });
      else settle({ state: "unusable", reason: `flock helper for ${file} exited ${code} before taking the lock (slot file not lockable?)` });
    });
  });
}

const warnedSlots = new Set<string>();

export type SharedPass =
  | { state: "held"; slotIndex: number; release(): void }
  | { state: "busy" }
  | { state: "unusable"; reason: string };

let flockUnusable = new Map<string, string>();

/**
 * One pass over slots 1..slots: take the first free one. `busy` when all are taken,
 * `unusable` when kernel locking or the directory cannot be used (caller falls back).
 */
export async function acquireSharedSlot(
  dir: string,
  slots: number,
  flockPath = "flock",
  warn: (msg: string) => void = () => {},
): Promise<SharedPass> {
  const cached = flockUnusable.get(flockPath);
  if (cached) return { state: "unusable", reason: cached };
  const bad = checkSharedDir(dir);
  if (bad) return { state: "unusable", reason: bad };
  let skipped = 0;
  for (let i = 1; i <= slots; i++) {
    const file = join(dir, `slot-${i}`);
    try {
      const st = lstatSync(file, { throwIfNoEntry: false });
      if (st === undefined) closeSync(openSync(file, "a", 0o600));
      else if (!st.isFile()) {
        if (!warnedSlots.has(file)) {
          warnedSlots.add(file);
          warn(`${file} is not a regular file; slot ${i} is treated as taken`);
        }
        skipped++;
        continue;
      }
    } catch (err) {
      return { state: "unusable", reason: `cannot prepare ${file}: ${(err as Error).message}` };
    }
    const r = await tryHoldSlot(file, flockPath);
    if (r.state === "held") return { state: "held", slotIndex: i, release: r.release };
    if (r.state === "unusable") {
      if (r.global) flockUnusable.set(flockPath, r.reason);
      return { state: "unusable", reason: r.reason };
    }
    if (r.warning && !warnedSlots.has(file)) {
      warnedSlots.add(file);
      warn(r.warning);
    }
  }
  if (slots > 0 && skipped === slots) {
    return { state: "unusable", reason: `every slot file under ${dir} is not a regular file` };
  }
  return { state: "busy" };
}

/**
 * Unit tests for the shared heavy-job slot pool (issue #2): bridge compiles and al-runner
 * wrapper test runs draw from one kernel-flock pool of <dir>/slot-<i> files (i is 1-based).
 * Linux-only except AC12. The wrapper-driven tests need AL_RUNNER_WRAPPER=<path to wrapper>.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as alcSlots from "../../dist/tools/alcSlots.js";
const { SlotBusyError, acquireAlcSlot, maxParallelAlc } = alcSlots;
import { runAlcCompile, withSlotWarning } from "../../dist/tools/compile.js";

const LINUX = { skip: process.platform !== "linux" };
const WRAPPER = process.env.AL_RUNNER_WRAPPER;
const XWRAP = {
  skip: process.platform !== "linux" || (!WRAPPER && "set AL_RUNNER_WRAPPER=<path to al-runner wrapper>"),
};
const ALC_SLOTS_URL = pathToFileURL(join(import.meta.dirname, "../../dist/tools/alcSlots.js")).href;

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() is truthy (kernel unlock is async after release / kill). */
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("until: timed out");
    await sleep(20);
  }
}

/** Slot-guarded options: explicit total, tmp shared dir, fast poll. */
const opts = (sharedDir, slots, over = {}) => ({
  sharedDir,
  dir: join(sharedDir, "..legacy-unused"),
  slots,
  staleMs: 60_000,
  waitMs: 300,
  pollMs: 20,
  platform: "linux",
  ...over,
});

const children = new Set();
function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
after(() => {
  for (const c of children) c.kill("SIGKILL");
});

/**
 * Hold slot <i> exactly like the wrapper does for a test run: the contract helper command line.
 * Resolves once the helper printed `held`.
 */
async function holdSlot(dir, i) {
  const child = track(
    spawn("flock", ["-o", "-n", "-E", "75", join(dir, `slot-${i}`), "sh", "-c", "echo held; exec cat >/dev/null"], {
      stdio: ["pipe", "pipe", "ignore"],
    }),
  );
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`helper for slot-${i} did not report held`)), 5000);
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      if (/^held$/m.test(buf)) {
        clearTimeout(t);
        resolve();
      }
    });
    exited.then((code) => {
      clearTimeout(t);
      reject(new Error(`helper for slot-${i} exited ${code} before held`));
    });
  });
  return {
    async release() {
      child.stdin.destroy();
      child.kill("SIGKILL");
      await exited;
    },
    kill: () => child.kill("SIGKILL"),
  };
}

/** True when a non-blocking flock on slot-<i> succeeds, i.e. nobody holds it. */
function slotFree(dir, i) {
  return new Promise((resolve) => {
    const c = spawn("flock", ["-n", "-E", "75", join(dir, `slot-${i}`), "true"], { stdio: "ignore" });
    c.once("exit", (code) => resolve(code === 0));
  });
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function fakeAlc(root) {
  const marker = join(root, "alc-ran");
  const alc = join(root, "alc");
  writeFileSync(alc, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  return { alc, marker };
}
const compileParams = (alcPath, root) => ({
  alcPath,
  projectPath: root,
  packageCachePaths: [],
  assemblyProbingPaths: [],
  enableExternalRulesets: false,
  generateCode: false,
  timeoutMs: 10_000,
});

// ---------------------------------------------------------------------------
// AC1 / AC4 / AC5: one shared cap
// ---------------------------------------------------------------------------

test("AC1: N slots held by any mix of external holders and bridge slots make the next compile wait, then BUSY", LINUX, async () => {
  const dir = tmp("shared-slots-");
  const held = [];
  try {
    held.push(await holdSlot(dir, 1)); // a wrapper test run
    const mine = await acquireAlcSlot(opts(dir, 2)); // a bridge compile
    assert.equal(mine.backend, "flock");
    await assert.rejects(() => acquireAlcSlot(opts(dir, 2)), SlotBusyError);
    mine.release();
    // one slot is free again: the next one is admitted
    const again = await until(() => acquireAlcSlot(opts(dir, 2, { waitMs: 50 })).catch(() => null));
    assert.equal(again.backend, "flock");
    again.release();
  } finally {
    for (const h of held) await h.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC1: slot files are never deleted, truncated or replaced by a bridge release", LINUX, async () => {
  const dir = tmp("shared-slots-");
  try {
    const s = await acquireAlcSlot(opts(dir, 1));
    assert.ok(existsSync(join(dir, "slot-1")));
    s.release();
    s.release(); // idempotent
    await until(() => slotFree(dir, 1));
    assert.ok(existsSync(join(dir, "slot-1")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC4: AL_BRIDGE_MAX_PARALLEL_ALC=N is the total; N=3 admits a third holder across kinds, a fourth waits", LINUX, async () => {
  assert.equal(maxParallelAlc({ AL_BRIDGE_MAX_PARALLEL_ALC: "3" }), 3);
  const dir = tmp("shared-slots-");
  const held = [];
  try {
    held.push(await holdSlot(dir, 1), await holdSlot(dir, 2));
    const third = await acquireAlcSlot(opts(dir, 3));
    assert.equal(third.backend, "flock");
    await assert.rejects(() => acquireAlcSlot(opts(dir, 3)), SlotBusyError);
    third.release();
  } finally {
    for (const h of held) await h.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC4: the env total drives runAlcCompile (N=1, slot-1 held externally => BUSY, alc never started)", LINUX, async () => {
  const dir = tmp("shared-slots-");
  const root = tmp("fake-alc-");
  const { alc, marker } = fakeAlc(root);
  let h;
  try {
    h = await holdSlot(dir, 1);
    await withEnv(
      { AL_RUNNER_LOCK_DIR: dir, AL_BRIDGE_MAX_PARALLEL_ALC: "1", AL_BRIDGE_SLOT_WAIT_MS: "300" },
      async () => {
        await assert.rejects(() => runAlcCompile(compileParams(alc, root)), SlotBusyError);
      },
    );
    assert.equal(existsSync(marker), false);
  } finally {
    await h?.release();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC5: with no budget setting the total is 2: two held => BUSY, one held => alc runs, slot-3 is not counted", LINUX, async () => {
  assert.equal(maxParallelAlc({}), 2);
  const dir = tmp("shared-slots-");
  const root = tmp("fake-alc-");
  const { alc, marker } = fakeAlc(root);
  const held = [];
  const env = { AL_RUNNER_LOCK_DIR: dir, AL_BRIDGE_MAX_PARALLEL_ALC: undefined, AL_BRIDGE_SLOT_WAIT_MS: "300" };
  try {
    held.push(await holdSlot(dir, 1), await holdSlot(dir, 2));
    await withEnv(env, () => assert.rejects(() => runAlcCompile(compileParams(alc, root)), SlotBusyError));
    assert.equal(existsSync(marker), false);
    await held.pop().release(); // slot-2 free
    await until(() => slotFree(dir, 2));
    await withEnv(env, () => runAlcCompile(compileParams(alc, root)));
    assert.equal(existsSync(marker), true);
  } finally {
    for (const h of held) await h.release();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC2: every kind can use every slot
// ---------------------------------------------------------------------------

test("AC2: a freed slot goes to a waiting bridge compile whichever kind held it", LINUX, async () => {
  const dir = tmp("shared-slots-");
  const a = await holdSlot(dir, 1);
  const b = await holdSlot(dir, 2);
  try {
    const waiter = acquireAlcSlot(opts(dir, 2, { waitMs: 5000 }));
    await sleep(100);
    await b.release(); // the higher slot frees: the waiter must take it, not only slot-1
    const got = await waiter;
    assert.equal(got.backend, "flock");
    got.release();
    const waiter2 = acquireAlcSlot(opts(dir, 2, { waitMs: 5000 }));
    await sleep(100);
    await a.release(); // and the lower one
    const got2 = await waiter2;
    assert.equal(got2.backend, "flock");
    got2.release();
  } finally {
    await a.release();
    await b.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC2: a slot released by the bridge can be taken by a test-run holder, on every slot of the total", LINUX, async () => {
  const dir = tmp("shared-slots-");
  try {
    const s1 = await acquireAlcSlot(opts(dir, 2));
    const s2 = await acquireAlcSlot(opts(dir, 2));
    assert.equal(s1.backend, "flock");
    assert.equal(await slotFree(dir, 1), false, "a bridge slot is a kernel lock visible to other holders");
    assert.equal(await slotFree(dir, 2), false);
    s1.release();
    s2.release();
    for (const i of [1, 2]) {
      await until(() => slotFree(dir, i));
      const h = await holdSlot(dir, i);
      await h.release();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC3: SIGKILL frees the slot for both kinds
// ---------------------------------------------------------------------------

test("AC3: a bridge process killed with SIGKILL frees its slot at once (no stale age)", LINUX, async () => {
  const dir = tmp("shared-slots-");
  try {
    const script = `
      const { acquireAlcSlot } = await import(${JSON.stringify(ALC_SLOTS_URL)});
      await acquireAlcSlot({ sharedDir: ${JSON.stringify(dir)}, dir: ${JSON.stringify(join(dir, "legacy"))},
        slots: 1, staleMs: 3_600_000, waitMs: 0, pollMs: 20, platform: "linux" });
      console.log("held");
      setInterval(() => {}, 1000);`;
    const child = track(spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] }));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("child never held")), 8000);
      child.stdout.on("data", (d) => /held/.test(String(d)) && (clearTimeout(t), resolve()));
      child.once("exit", () => reject(new Error("child exited")));
    });
    await assert.rejects(() => acquireAlcSlot(opts(dir, 1)), SlotBusyError); // really held by the child
    child.kill("SIGKILL");
    const next = await until(() => acquireAlcSlot(opts(dir, 1, { waitMs: 50 })).catch(() => null));
    assert.equal(next.backend, "flock");
    next.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC3: a test-run holder killed with SIGKILL frees its slot for the bridge", LINUX, async () => {
  const dir = tmp("shared-slots-");
  try {
    const h = await holdSlot(dir, 1);
    await assert.rejects(() => acquireAlcSlot(opts(dir, 1)), SlotBusyError);
    h.kill();
    const next = await until(() => acquireAlcSlot(opts(dir, 1, { waitMs: 50 })).catch(() => null));
    assert.equal(next.backend, "flock");
    next.release();
    await h.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC7: progress notices
// ---------------------------------------------------------------------------

test("AC7: the wait notice cadence default is 15 s", () => {
  assert.equal(alcSlots.WAIT_NOTICE_MS, 15_000);
});

test("AC7: a waiting compile emits a notice at once and then repeatedly (phrase 'alc slot' kept)", LINUX, async () => {
  const dir = tmp("shared-slots-");
  const h = await holdSlot(dir, 1);
  try {
    const notes = [];
    await assert.rejects(
      () => acquireAlcSlot(opts(dir, 1, { waitMs: 400, noticeEveryMs: 60, onWait: (m) => notes.push(m) })),
      SlotBusyError,
    );
    assert.ok(notes.length >= 3, `expected >= 3 notices, got ${notes.length}`);
    assert.match(notes[0], /alc slot/);
  } finally {
    await h.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC8: BUSY on wait timeout
// ---------------------------------------------------------------------------

test("AC8: a timed-out slot wait is BUSY and the compile never starts", LINUX, async () => {
  const dir = tmp("shared-slots-");
  const root = tmp("fake-alc-");
  const { alc, marker } = fakeAlc(root);
  const h = await holdSlot(dir, 1);
  try {
    await withEnv(
      { AL_RUNNER_LOCK_DIR: dir, AL_BRIDGE_MAX_PARALLEL_ALC: "1", AL_BRIDGE_SLOT_WAIT_MS: "200" },
      async () => {
        await assert.rejects(
          () => runAlcCompile(compileParams(alc, root)),
          (e) => e instanceof SlotBusyError && /^BUSY:/.test(e.message),
        );
      },
    );
    assert.equal(existsSync(marker), false, "alc must not have been started");
  } finally {
    await h.release();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC10: different totals
// ---------------------------------------------------------------------------

test("AC10: bridge total A=1 against a wrapper with B=2: bridge never takes slot-2", LINUX, async () => {
  const dir = tmp("shared-slots-");
  try {
    const mine = await acquireAlcSlot(opts(dir, 1)); // slot-1
    assert.equal(mine.backend, "flock");
    await assert.rejects(() => acquireAlcSlot(opts(dir, 1)), SlotBusyError); // slot-2 is free but not the bridge's
    assert.equal(await slotFree(dir, 2), true);
    const wrapper = await holdSlot(dir, 2); // the wrapper uses its second slot: 2 = B in total
    mine.release();
    await wrapper.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC10: bridge total A=2 against a wrapper with B=1: never more than 2 together", LINUX, async () => {
  const dir = tmp("shared-slots-");
  const wrapper = await holdSlot(dir, 1);
  try {
    const mine = await acquireAlcSlot(opts(dir, 2)); // slot-2
    await assert.rejects(() => acquireAlcSlot(opts(dir, 2)), SlotBusyError); // 1 wrapper + 1 bridge = 2 = max(A,B)
    mine.release();
  } finally {
    await wrapper.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC11: cannot enforce => visible warning, never silently uncapped
// ---------------------------------------------------------------------------

function unusableCase(name, reason, setup, extra = {}) {
  test(`AC11: ${name} => legacy pool + visible warning`, LINUX, async () => {
    const root = tmp("shared-bad-");
    try {
      const { sharedDir, ...over } = setup(root);
      const slot = await acquireAlcSlot({
        ...opts(sharedDir, 2, { dir: join(root, "legacy") }),
        ...over,
        ...extra,
      });
      assert.equal(slot.backend, "legacy");
      assert.match(slot.warning ?? "", new RegExp(`NOT enforced.*${reason}`, "i"));
      slot.release();
    } finally {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

unusableCase("group-writable shared dir", "writable", (root) => {
  const d = join(root, "gw");
  mkdirSync(d, { mode: 0o700 });
  chmodSync(d, 0o775);
  return { sharedDir: d };
});
unusableCase("shared dir is a symlink", "symlink", (root) => {
  const real = join(root, "real");
  mkdirSync(real, { mode: 0o700 });
  const link = join(root, "link");
  symlinkSync(real, link);
  return { sharedDir: link };
});
unusableCase("shared dir is not a directory", "not a directory", (root) => {
  const f = join(root, "file");
  writeFileSync(f, "x");
  return { sharedDir: f };
});
unusableCase(
  "flock missing",
  "flock",
  (root) => ({ sharedDir: join(root, "ok"), flockPath: join(root, "no-such-flock") }),
);

test("AC11: a healthy shared dir enforces the cap and carries no warning", LINUX, async () => {
  const dir = tmp("shared-slots-");
  try {
    const s = await acquireAlcSlot(opts(dir, 1));
    assert.equal(s.backend, "flock");
    assert.equal(s.warning, undefined);
    s.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC12: Windows keeps the legacy cap and never touches the shared dir / flock
// ---------------------------------------------------------------------------

test("AC12: platform win32 caps at N with the legacy pool and never touches sharedDir or flock", async () => {
  const root = tmp("shared-win-");
  try {
    const sharedDir = join(root, "shared-must-not-exist");
    const marker = join(root, "flock-called");
    const flockPath = join(root, "fake-flock");
    writeFileSync(flockPath, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const o = { sharedDir, flockPath, dir: join(root, "legacy"), slots: 2, staleMs: 60_000, waitMs: 200, pollMs: 20, platform: "win32" };
    const a = await acquireAlcSlot(o);
    const b = await acquireAlcSlot(o);
    assert.equal(a.backend, "legacy");
    assert.equal(a.warning, undefined);
    await assert.rejects(() => acquireAlcSlot(o), SlotBusyError);
    a.release();
    const c = await acquireAlcSlot(o);
    b.release();
    c.release();
    assert.equal(existsSync(sharedDir), false);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cross-repo: the real al-runner wrapper (gated)
// ---------------------------------------------------------------------------

/** Fake runner under a tmp HOME: records that it started, then idles (or exits at once). */
function wrapperHome(root, idle) {
  const home = join(root, "home");
  mkdirSync(join(home, ".dotnet", "tools"), { recursive: true });
  const started = join(root, "runner-started");
  writeFileSync(
    join(home, ".dotnet", "tools", "al-runner"),
    `#!/bin/sh\ntouch '${started}'\n${idle ? "exec sleep 60" : "exit 0"}\n`,
    { mode: 0o755 },
  );
  return { home, started };
}
function runWrapper(home, lockDir, env = {}, args = ["--run", "x"]) {
  const child = track(
    spawn(WRAPPER, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: home,
        AL_RUNNER_LOCK_DIR: lockDir,
        AL_RUNNER_WAIT_TIMEOUT: "1",
        AL_RUNNER_NOTICE_INTERVAL: "1",
        ...env,
      },
    }),
  );
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  return { child, exited, stderr: () => err };
}

test("xwrap AC1/AC3: a wrapper test run holds a bridge-visible slot until it is SIGKILLed", XWRAP, async () => {
  const root = tmp("xwrap-");
  const dir = join(root, "locks");
  try {
    const { home, started } = wrapperHome(root, true);
    const w = runWrapper(home, dir, { AL_BRIDGE_MAX_PARALLEL_ALC: "1", AL_RUNNER_WAIT_TIMEOUT: "30" });
    await until(() => existsSync(started), 8000);
    await assert.rejects(() => acquireAlcSlot(opts(dir, 1)), SlotBusyError);
    w.child.kill("SIGKILL");
    const next = await until(() => acquireAlcSlot(opts(dir, 1, { waitMs: 50 })).catch(() => null));
    assert.equal(next.backend, "flock");
    next.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("xwrap AC1/AC4: a bridge-held slot makes the wrapper wait then exit 75 BUSY without starting the runner", XWRAP, async () => {
  const root = tmp("xwrap-");
  const dir = join(root, "locks");
  try {
    const { home, started } = wrapperHome(root, false);
    const mine = await acquireAlcSlot(opts(dir, 1));
    const w = runWrapper(home, dir, { AL_BRIDGE_MAX_PARALLEL_ALC: "1" });
    assert.equal(await w.exited, 75);
    assert.match(w.stderr(), /BUSY/);
    assert.equal(existsSync(started), false);
    mine.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("xwrap AC2: a slot freed by the bridge is taken by a waiting wrapper test run", XWRAP, async () => {
  const root = tmp("xwrap-");
  const dir = join(root, "locks");
  try {
    const { home, started } = wrapperHome(root, false);
    const mine = await acquireAlcSlot(opts(dir, 1));
    const w = runWrapper(home, dir, { AL_BRIDGE_MAX_PARALLEL_ALC: "1", AL_RUNNER_WAIT_TIMEOUT: "20" });
    await sleep(700);
    assert.equal(existsSync(started), false, "wrapper must wait while the bridge holds the only slot");
    mine.release();
    assert.equal(await w.exited, 0);
    assert.equal(existsSync(started), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("xwrap AC3: a SIGKILLed bridge frees its slot for the wrapper", XWRAP, async () => {
  const root = tmp("xwrap-");
  const dir = join(root, "locks");
  try {
    const { home, started } = wrapperHome(root, false);
    const script = `
      const { acquireAlcSlot } = await import(${JSON.stringify(ALC_SLOTS_URL)});
      await acquireAlcSlot({ sharedDir: ${JSON.stringify(dir)}, dir: ${JSON.stringify(join(root, "legacy"))},
        slots: 1, staleMs: 3_600_000, waitMs: 0, pollMs: 20, platform: "linux" });
      console.log("held");
      setInterval(() => {}, 1000);`;
    const bridge = track(spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] }));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("bridge child never held")), 8000);
      bridge.stdout.on("data", (d) => /held/.test(String(d)) && (clearTimeout(t), resolve()));
    });
    assert.equal(await runWrapper(home, dir, { AL_BRIDGE_MAX_PARALLEL_ALC: "1" }).exited, 75, "bridge slot must block the wrapper");
    bridge.kill("SIGKILL");
    const w = runWrapper(home, dir, { AL_BRIDGE_MAX_PARALLEL_ALC: "1", AL_RUNNER_WAIT_TIMEOUT: "20" });
    assert.equal(await w.exited, 0);
    assert.equal(existsSync(started), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("xwrap AC4/AC5: the wrapper reads the total from AL_BRIDGE_MAX_PARALLEL_ALC (default 2)", XWRAP, async () => {
  const root = tmp("xwrap-");
  const dir = join(root, "locks");
  const held = [];
  try {
    const { home, started } = wrapperHome(root, false);
    mkdirSync(dir, { mode: 0o700 });
    held.push(await holdSlot(dir, 1), await holdSlot(dir, 2));
    // default total 2, both taken => BUSY
    assert.equal(await runWrapper(home, dir).exited, 75);
    assert.equal(existsSync(started), false);
    // total raised to 3 => slot-3 is usable
    assert.equal(await runWrapper(home, dir, { AL_BRIDGE_MAX_PARALLEL_ALC: "3" }).exited, 0);
    assert.equal(existsSync(started), true);
  } finally {
    for (const h of held) await h.release();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC11 (compile output) and AC7 (default cadence) — added after the three-way review
// ---------------------------------------------------------------------------

test("AC11: an unenforceable shared cap is reported by runAlcCompile (slotWarning), not run silently", LINUX, async () => {
  const dir = tmp("shared-slots-");
  const root = tmp("fake-alc-");
  const { alc, marker } = fakeAlc(root);
  try {
    chmodSync(dir, 0o777); // group/other writable => unusable shared dir
    const run = await withEnv(
      { AL_RUNNER_LOCK_DIR: dir, AL_BRIDGE_MAX_PARALLEL_ALC: "1", AL_BRIDGE_SLOT_WAIT_MS: "1000" },
      () => runAlcCompile(compileParams(alc, root)),
    );
    assert.equal(existsSync(marker), true, "falls back to the bridge-only cap and still compiles");
    assert.match(run.slotWarning ?? "", /NOT enforced.*writable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC11: withSlotWarning puts the warning in the result's warning field (after an existing one)", () => {
  assert.deepEqual(withSlotWarning({ a: 1 }, undefined), { a: 1 });
  assert.deepEqual(withSlotWarning({ a: 1 }, "W"), { a: 1, warning: "W" });
  assert.deepEqual(withSlotWarning({ a: 1, warning: "old" }, "W"), { a: 1, warning: "old; W" });
});

test("AC7: with the default cadence the wait notice repeats within 15 s", LINUX, async () => {
  const dir = tmp("shared-slots-");
  const ac = new AbortController();
  const notices = [];
  let h;
  try {
    h = await holdSlot(dir, 1);
    const p = acquireAlcSlot({
      ...opts(dir, 1, { waitMs: 0, pollMs: 250 }),
      signal: ac.signal,
      onWait: (m) => notices.push([Date.now(), m]),
    }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 16_500));
    ac.abort();
    await p;
    assert.ok(notices.length >= 2, `expected >= 2 notices in 16.5 s, got ${notices.length}`);
    assert.ok(notices[1][0] - notices[0][0] <= 15_500, "second notice came later than ~15 s after the first");
  } finally {
    await h?.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review-finding regressions
// ---------------------------------------------------------------------------
const { acquireSharedSlot, tryHoldSlot } = await import("../../dist/tools/sharedSlots.js");

test("review: a non-ENOENT spawn error is busy with a warning and is not cached as unusable", LINUX, async () => {
  const root = tmp("shared-eacces-");
  try {
    // A non-executable file => spawn EACCES (not ENOENT).
    const fake = join(root, "flock-noexec");
    writeFileSync(fake, "#!/bin/sh\n", { mode: 0o644 });
    const dir = join(root, "d");
    const warns = [];
    const r = await acquireSharedSlot(dir, 1, fake, (m) => warns.push(m));
    assert.equal(r.state, "busy");
    assert.ok(warns.some((m) => /could not be started/.test(m)), "warns once");
    // Not cached: after the binary becomes usable the next pass holds the slot.
    writeFileSync(fake, '#!/bin/sh\necho held\nexec cat >/dev/null\n');
    chmodSync(fake, 0o755);
    const r2 = await acquireSharedSlot(dir, 1, fake);
    assert.equal(r2.state, "held");
    r2.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const NOT_ROOT = { skip: process.platform !== "linux" || process.getuid?.() === 0 };

test("review: an unopenable slot file (helper exit != 75 before held) is unusable, so the legacy fallback warns NOT enforced", NOT_ROOT, async () => {
  const dir = tmp("shared-mode0-");
  try {
    const f = join(dir, "slot-1");
    writeFileSync(f, "");
    chmodSync(f, 0o000);
    const r = await acquireSharedSlot(dir, 1);
    assert.equal(r.state, "unusable");
    assert.match(r.reason, /exited \d+/);
    const s = await acquireAlcSlot(opts(dir, 1, { dir: join(dir, "legacy"), waitMs: 2000 }));
    assert.equal(s.backend, "legacy");
    assert.match(s.warning ?? "", /NOT enforced/);
    s.release();
  } finally {
    try { chmodSync(join(dir, "slot-1"), 0o600); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: every slot index a non-regular file is unusable, not endless busy", LINUX, async () => {
  const dir = tmp("shared-nonreg-");
  try {
    mkdirSync(join(dir, "slot-1"));
    symlinkSync("/etc/hostname", join(dir, "slot-2"));
    const r = await acquireSharedSlot(dir, 2);
    assert.equal(r.state, "unusable");
    assert.match(r.reason, /not a regular file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: runAlcCompile releases its slot when setup throws after acquiring it", LINUX, async () => {
  const dir = tmp("shared-throw-");
  const root = tmp("fake-alc-");
  const { alc } = fakeAlc(root);
  try {
    await withEnv(
      { AL_RUNNER_LOCK_DIR: dir, AL_BRIDGE_MAX_PARALLEL_ALC: "1", AL_BRIDGE_SLOT_WAIT_MS: "300", TMPDIR: join(root, "no-such-tmp") },
      async () => {
        await assert.rejects(() => runAlcCompile(compileParams(alc, root)), /ENOENT/);
        const s = await acquireAlcSlot(opts(dir, 1, { waitMs: 300 }));
        assert.equal(s.backend, "flock");
        s.release();
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("review: fallback to the legacy pool after waiting spends only the remaining wait", LINUX, async () => {
  const dir = tmp("shared-remain-");
  const root = tmp("remain-");
  try {
    const legacy = join(root, "legacy");
    mkdirSync(legacy);
    // Legacy pool full with a fresh live lock.
    const o = opts(dir, 1, { dir: legacy, waitMs: 600, slots: 1 });
    const hold = await acquireAlcSlot({ ...o, platform: "win32" });
    // Shared pass is busy for ~300 ms (external holder), then flock goes unusable.
    const h = await holdSlot(dir, 1);
    const flockStub = join(root, "flock-later");
    const t0 = Date.now();
    // Stub: the first shared pass takes 0.4 s, then reports flock unusable (exit 64).
    writeFileSync(flockStub, "#!/bin/sh\nsleep 0.4\nexit 64\n", { mode: 0o755 });
    await assert.rejects(() => acquireAlcSlot({ ...o, flockPath: flockStub }), SlotBusyError);
    assert.ok(Date.now() - t0 < 1000, `total wait ${Date.now() - t0}ms exceeded waitMs budget`);
    await h.release();
    hold.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("review: SlotBusyError wording", () => {
  const e = new SlotBusyError(1000, 2);
  assert.match(e.message, /^BUSY:.*other sessions are compiling or running tests.*AL_BRIDGE_MAX_PARALLEL_ALC/);
});

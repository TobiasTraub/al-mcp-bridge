# Spec — TobiasTraub/al-mcp-bridge#2: compiles and test runs exceed the machine's heavy-job budget

Ticket: https://github.com/TobiasTraub/al-mcp-bridge/issues/2 · Persona: the VM owner running several
Claude sessions that compile (al-bridge) and test (al-runner wrapper) at the same time · Route: spec
Repos: TobiasTraub/al-mcp-bridge (this PR) + socitas-gmbh/claude-trto `trto-al/scripts/al-runner/al-runner`
(companion draft PR) — decided in design.

## Problem
Bridge compiles and al-runner test runs each cost 1-2 GB, but they are capped by two pools that do
not see each other (bridge: 2 slots, own lock files; wrapper: 1 slot, kernel locks). On an
8-core / 15 GB VM three heavy jobs can run at once, which is how the machine starts paging. The
budget has to hold regardless of which mix of sessions compiles or tests.

## Must
- M1 On Linux (where the wrapper runs), bridge compiles and wrapper test runs draw from one shared
  budget of heavy AL jobs. Windows: see N1.
- M2 A slot whose holder dies is free again for both kinds of caller as soon as the holder is gone —
  no age-based reclaim, no manual cleanup.
- M3 One setting governs the total. `AL_BRIDGE_MAX_PARALLEL_ALC` keeps working as that total;
  with nothing set the total is 2.
- M4 `AL_RUNNER_SLOTS` no longer sets anything; when set, the wrapper says once on stderr that it
  is ignored and names the setting that governs the total.
- M5 A caller waiting for a slot keeps reporting progress (bridge: its wait notices; wrapper:
  stderr notices), as today.
- M6 A timed-out wait stays distinguishable from a real result on both sides: the bridge reports
  BUSY (no diagnostics), the wrapper exits 75 without starting the runner.

## Must not
- N1 The bridge's behaviour on Windows does not change (its current cap keeps working there).
- N2 When the bridge and the wrapper see different budget values, the number of heavy jobs never
  exceeds the larger of them.
- N3 Neither side ever runs uncapped silently: whenever it cannot enforce the shared cap, it says so
  visibly.
- N4 Wrapper invocations that take no slot today (`--watch`, `--server`, `--dap`, `--version`,
  `--help`, `--guide`, no arguments) still take none.
- N5 The wait-timeout settings (`AL_BRIDGE_SLOT_WAIT_MS`, `AL_RUNNER_WAIT_TIMEOUT`) keep their meaning.

## Acceptance
- AC1 WHEN, on Linux, the total is N and N heavy jobs in any mix of bridge compiles and wrapper test runs hold
  slots THE SYSTEM SHALL make the next compile or test run wait. (M1)
- AC2 WHEN, on Linux, a slot frees while both a compile and a test run are waiting THE SYSTEM SHALL let a
  waiter take it, whichever kind it is, so each kind can use every slot of the total. (M1)
- AC3 IF, on Linux, a slot holder of either kind is killed with SIGKILL THEN THE SYSTEM SHALL let the next
  caller of either kind take that slot without manual cleanup and without waiting for a stale age. (M2)
- AC4 WHEN, on Linux, only `AL_BRIDGE_MAX_PARALLEL_ALC` is set to N THE SYSTEM SHALL cap bridge compiles and
  wrapper test runs together at N. (M3)
- AC5 WHEN, on Linux, no budget setting is set THE SYSTEM SHALL cap bridge compiles and wrapper test runs
  together at 2. (M3)
- AC6 WHEN `AL_RUNNER_SLOTS` is set THE SYSTEM SHALL leave the total unchanged and print one stderr
  line naming the setting that governs it. (M4)
- AC7 WHEN a bridge compile or a wrapper test run has to wait for a slot THE SYSTEM SHALL emit a
  progress notice when the wait starts and at least every 15 s until it ends. (M5)
- AC8 IF a bridge compile's wait for a slot times out THEN THE SYSTEM SHALL return a BUSY result
  carrying no compile diagnostics. (M6)
- AC9 IF a wrapper test run's wait for a slot times out THEN THE SYSTEM SHALL exit 75 with a BUSY
  line on stderr and not start the runner. (M6)
- AC10 IF, on Linux, the bridge and the wrapper are configured with different totals A < B THEN THE SYSTEM
  SHALL never hold more than B slots at once. (N2)
- AC11 IF the bridge or the wrapper cannot enforce the shared cap THEN THE SYSTEM SHALL report that in
  the bridge's compile output / the wrapper's stderr rather than run silently uncapped. (N3)
- AC12 WHEN the bridge runs on Windows THE SYSTEM SHALL keep capping concurrent alc runs at
  `AL_BRIDGE_MAX_PARALLEL_ALC` as today. (N1)
- AC13 WHEN the wrapper is called in a mode that takes no slot today THE SYSTEM SHALL start the
  runner at once even with every slot taken. (N4)

## Out of scope
- CPU/memory caps per job (`systemd-run`), .NET GC tuning.
- Any new Windows locking mechanism.
- Making sessions use the slot-guarded wrapper (socitas-gmbh/claude-trto#8).
- Bridges or wrappers started before the update: they keep the old pools until restarted.
- Sharing one budget across different OS users (the budget is per user, as the wrapper's is today).
- Per-kind sub-caps (e.g. "at most 1 of the 2 may be a test run").

## Open (implementer's call)
- How the bridge holds a kernel lock from Node (flock(1), native addon, helper process …) and
  whether the lock lives with the bridge process or the alc child.
- Whether a new neutral name for the total is introduced (if so it wins over
  `AL_BRIDGE_MAX_PARALLEL_ALC`) and where the shared lock location lives.
- What the bridge does when kernel locking is unusable (fall back to its old pool or run uncapped),
  as long as N3 holds.
- How the ACs are proven on each side (`npm run test:unit` here, `test_al_runner.py` in claude-trto).

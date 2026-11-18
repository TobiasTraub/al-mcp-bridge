## Triage
- Scan: agent-guard:scan clean (0 findings); author OWNER.
- Blockers: claude-trto#7 closed 2026-11-18 (merged PR socitas-gmbh/claude-trto#9, flock wrapper); no open blockers.
- Already implemented? No: src/tools/alcSlots.ts is the O_EXCL+pid pool (compile.ts:374 only); no shared pool with al-runner.
- Rejected before? No .out-of-scope/ in repo.
- Bug claim: n/a (feature). Brief seed: issue body is a to-tickets issue (AC1-AC5, out of scope list) -> candidate acceptance entries.
- Wrapper protocol (from PR 9): flock slots in /tmp/al-runner-slots-<uid> (0700), AL_RUNNER_SLOTS default 1, AL_RUNNER_WAIT_TIMEOUT 600s, exit 75 = BUSY, notice every 10s, AL_RUNNER_LOCK_DIR override. Wrapper lives in socitas-gmbh/claude-trto trto-al/scripts/al-runner/al-runner.

## Routing
- Route: spec — changes a cross-repo lock protocol (bridge in TS + bash wrapper in another repo), architecture-binding.
- Design model: opus (flag --opus).
- Open for design: Node has no kernel flock -> how the bridge takes flock locks; which repo moves; slot dir/name; total-budget variable.

## Design (session on opus, 2026-11-18)
### Problem
Persona: the VM owner running several Claude sessions that each compile (al-bridge, alc) and test (al-runner wrapper).
Two independent pools — bridge O_EXCL+pid lock files in `$LOCALAPPDATA|tmpdir/al-mcp-bridge/slots/slot-<0..N-1>.lock`
(src/tools/alcSlots.ts, default 2) and the wrapper's flock slots `/tmp/al-runner-slots-$EUID/slot-<1..N>`
(claude-trto trto-al/scripts/al-runner/al-runner, merged 567984f, default 1) — allow 3 heavy jobs on an 8-core/15 GB VM.
### Facts found
- Bridge: poll 1 s, onWait notice every 15 s, `SlotBusyError` "BUSY: …" after AL_BRIDGE_SLOT_WAIT_MS (default = compile timeout); only caller compile.ts:374. Windows path uses LOCALAPPDATA.
- Wrapper: flock -n per slot, kernel-released, lock dir safety checks (symlink/owner/mode 022) else runs unthrottled with a warning; exit 75 = BUSY; AL_RUNNER_SLOTS/AL_RUNNER_WAIT_TIMEOUT/AL_RUNNER_NOTICE_INTERVAL/AL_RUNNER_LOCK_DIR.
- Neither variable is set in ~/.claude/settings.json; the bridge MCP server inherits the session env (trto-al .mcp.json only adds AL_LS_PATH, AL_EXTRA_CODE_ANALYZERS).
- Node has no flock API; the bridge would need flock(1) or a native addon to hold a kernel lock (implementer's call).
- A wrapper that only knows N=1 never takes slot 2 → AC2/AC4 need the wrapper to learn the shared budget → claude-trto must change too.
- No `.ai/invariants.md`, no CLAUDE.md/CONTRIBUTING.md in this repo.
### Decisions
- Judge: Invariants → decline init-invariants, run with template defaults (only draft-PR / no-.dev apply to a TS repo) (0.92). Postmortem proposal: seed `.ai/invariants.md` for this repo.
- Repo scope (asked; judge ASK, pick A 0.75) → user: **Both repos** — bridge moves onto the wrapper's flock slots (PR here) + a companion draft PR in socitas-gmbh/claude-trto so the wrapper reads the shared budget. Rejected: bridge-only (AC2/AC4 unmet until a later change), wrapper onto O_EXCL+pid (against kernel-lock preference).
- Judge: AL_RUNNER_SLOTS → one total (default 2); AL_RUNNER_SLOTS ignored with one stderr warning naming the total setting (0.87). Rejected: per-kind sub-cap (conflicts with AC2), alias (two names for one setting).
### Ambiguity pass (no questions needed)
- Actors: budget per OS user, as the wrapper's is → out of scope across users.
- Data scope: n/a. Boundaries: invalid budget values → implementer (both sides already default with/without warning).
- Errors: BUSY on both sides (AC8/AC9); unsafe lock dir / no kernel lock → never silently uncapped (AC11).
- Existing behaviour: Windows unchanged (AC12), no-slot wrapper modes (AC13), wait-timeout settings keep meaning (N5).
- Upgrade: already-running bridges/wrappers keep old pools until restart → out of scope.
### Spec drafted → .dev/spec.md (13 ACs)
- Spec go (judge ASK 0.75) → user: **Go** (2026-11-18). Spec frozen.

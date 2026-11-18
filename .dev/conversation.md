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

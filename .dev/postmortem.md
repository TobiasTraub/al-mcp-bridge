# Postmortem — issue #2 (build session)
- Spec: held up; no amendment, no notification sent. Open items left to implementer (helper design, fallback) were decided in the plan.
- Review catches: tests-vs-spec/code-vs-tests found two unproven ACs (AC11 compile-output path, AC7 default cadence) -> tests added. code-review found 6 real bugs (transient spawn error cached forever, helper exit!=75 treated as busy, all-non-regular slots, slot leak before try, double wait budget, BUSY wording) -> fixed with tests. code-vs-spec and security-review found nothing.
- Not fixed (reviewer findings, reasons): helper killed mid-compile frees slot early (rare, would need a watcher); one flock spawn per slot per poll (cheap vs alc); duplicated wait loop (kept legacy path untouched for N1).
- AC10 wrapper side is covered by the AC4/AC5 wrapper tests (total 3 uses slot 3; default 2 never touches it) rather than a dedicated mismatch test; tests-vs-spec reviewer called this partial.
- Over-specified tests (exact ignore-line wording, AL_RUNNER_LOCK_DIR as location) accepted as implementation contract.
- Steps catching nothing: code-vs-spec review, security-review.
- Rule proposals (flow): a code-vs-tests mutation check should be a standard test-lane step; it found the two real gaps.

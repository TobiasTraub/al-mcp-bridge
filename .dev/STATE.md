ticket: TobiasTraub/al-mcp-bridge#2
label: al-mcp-bridge-2
default_branch: main
stack: node
build_cmd: npm run build
test_cmd: npm run test:unit
lint_cmd: npm run typecheck
baseline: green (build, typecheck, 94 unit tests)
ac_proof: test_cmd
docs_path: GitHub/TobiasTraub/al-mcp-bridge/issue-2
route: spec
design_model: opus
phase: done
last_step: floor
ac_hash: 0f0e2586ccf5bf9e
spec_approved: yes
companion_repo: socitas-gmbh/claude-trto (trto-al/scripts/al-runner/al-runner + test_al_runner.py; its own CLAUDE.md/version-bump rules apply; clone ~/so-vm/claude-trto, branch off main)
tags: mcp, al-runner, performance
worktree: /home/trto/so-vm/al-mcp-bridge--2-share-heavy-job-slot-pool
pr: https://github.com/TobiasTraub/al-mcp-bridge/pull/3
companion_pr: https://github.com/socitas-gmbh/claude-trto/pull/11

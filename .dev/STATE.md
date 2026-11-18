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
phase: spec-drafted
last_step: spec
spec_approved: yes
tags: mcp, al-runner, performance
worktree: /home/trto/so-vm/al-mcp-bridge--2-share-heavy-job-slot-pool

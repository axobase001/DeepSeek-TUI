# PR #7294 final-head validation — 2026-11-13

PR: https://github.com/codewhale-hq/Codewhale/pull/7294
Head: `61b889cf6ec10df5c048ef15715dbb272ccacf77`
Base synchronized through upstream `97c1ad9`; the net PR diff contains 10 evaluator-related files. PR #7262 was not changed.

## Hosted checks

| Platform / run | Command or gate | Observed result |
| --- | --- | --- |
| Upstream PR CI, https://github.com/codewhale-hq/Codewhale/actions/runs/43344788042 | Workspace format, strict Clippy, Windows `cargo check --workspace --all-targets --all-features --locked`, and applicable project guards | 10 jobs succeeded, 12 path-skipped, 0 failed; GitHub PR view also counted the successful triage check |
| Rocky Linux 8, https://github.com/axobase001/DeepSeek-TUI/actions/runs/43345093377 | `cargo build --locked -p codewhale-cli` | Exit 0; Rust 1.100.0, glibc 2.28 |
| Rocky Linux 8, same run | `cargo test --locked -p codewhale-engine verified_candidate --lib -- --nocapture` | Exit 0, 9 passed; runner lacked bubblewrap, so real isolation acceptance is recorded below |
| Rocky Linux 8, same run | `cargo check --locked -p codewhale-engine -p codewhale-workflow-js -p codewhale-sandbox` and `cargo package --list --locked -p codewhale-engine` | Exit 0 for both |
| Windows, same run | `cargo check --locked -p codewhale-engine -p codewhale-sandbox`; focused evaluator tests | Exit 0; 5 passed, 0 failed |
| macOS, same run | `cargo check --locked -p codewhale-engine -p codewhale-sandbox`; focused `cargo clippy --locked ... --lib -- -D warnings` | Exit 0 for both |
| Package file set, https://github.com/axobase001/DeepSeek-TUI/actions/runs/43345093627 | Exact `cargo package --list` files recompiled with local sibling crates after deleting `workflows/operate_best_of_n.workflow.js` from the checkout | Exit 0; source SHA in artifact matches this head. The listed engine crate contains `verified_candidate/{artifact,mod}.rs` and no repository Workflow script. |

The full hosted Linux job is red at its **standard package verification** step: `cargo package --locked -p codewhale-engine` exited 101 while resolving `codewhale-agent = "^0.10.3"`; the crates.io index offered up to 0.10.2. The command reached package preparation, then stopped before source verification. Raw package list and failure log: https://github.com/axobase001/DeepSeek-TUI/actions/runs/43345093377/artifacts/14002692655 . The successful independent file-set check uses local 0.10.3 sibling crates and does not replace that standard result.

## Actual Linux isolation and Workflow

On the 47 VPS, `nobody` (uid 65534) ran with 40 pre-existing synthetic tasks. A `prlimit --nproc=32:32` bubblewrap control exited 1 with `Creating new namespace failed: Resource temporarily unavailable`; `--nproc=4096:4096` succeeded. The final-head Rust test executable listed and ran all 9 evaluator tests under this ordinary user with bubblewrap: **9 passed, 0 failed, exit 0, 113.64 s**. This includes the writable-marker descendant timeout/cancellation check.

The actual final-head CLI/Workflow entry used a local scripted provider and synthetic coding fixtures. The self-reported PASS candidate failed 2 public cases; the isolated candidate passed 2 public cases and 3 public-plus-held-out replay cases. The run completed as `proposal_only`. The no-evaluator legacy path and modified Workflow source rejection each passed; all three scripts exited 0. An independent verifier recomputed 7 case outcomes, 2 sealed candidate tree hashes, the frozen baseline/oracle hashes, binary identity, and replay receipts: exit 0, `pass: true`.

The first non-root attempt exited 1 before tests because the extracted binary directory had mode `0700`; its log is retained. After changing only that directory to `0755`, `nobody` listed 9 tests and the full rerun passed. The 200 MB build ZIP and ~1 GB extracted binaries were removed from the VPS after SHA verification and evidence sync; free space returned to 3.3 GB. Small raw evidence remains on the VPS.

## Evidence identities

- Final Linux binary artifact: https://github.com/axobase001/DeepSeek-TUI/actions/runs/43345093377/artifacts/14001504445 ; ZIP SHA-256 `5109ba2a496b11ccd1a8772e54d54d73b0c1eab230c5ed9c09cfcc346366d64b`.
- CLI SHA-256 `49fb3d86cd6fa1cc61bc322811ca732e5bb9acb3fa2d9da798a475f6bec98646`; Rust test executable SHA-256 `3fc2d19f7d86870a9a82405fa65cbd10bfaadc26009b16eb43b3702b60333cb4`.
- Final native evidence tar SHA-256 `38df522717d487f48bf319df054752ffd33ddcd8720c740d813aa5d756a606e2`.
- Package file-set artifact: https://github.com/axobase001/DeepSeek-TUI/actions/runs/43345093627/artifacts/14001762330 ; ZIP SHA-256 `fc0a3095f004c26afab70caf13edf8ec28c8116ecb9239bbe5afb43a2d53c8f8`.
- Standard package failure artifact SHA-256 `b194c61724aeabbe192f9874ab537508acdeebb99417b404e533725f96df421b`.

Historical failures and earlier successful replays remain in the 2026-11-13 review-fixes evidence bundle and prior CI runs. This addendum records the upstream-synchronized final head and the external crates.io package gate without replacing those records.

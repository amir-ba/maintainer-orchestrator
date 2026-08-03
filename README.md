# Scale Maintainer Orchestrator

Windows automation for GitHub Project `amir-ba/1` that triages and processes Scale issues and pull requests. This repository is separate from the `telekom/scale` checkout it operates on.

## Requirements

- Windows PowerShell and Task Scheduler
- Node.js 24 or newer
- Git, GitHub CLI (`gh`), and GitHub Copilot CLI (`copilot`) on `PATH`
- A sibling Scale checkout at `..\scale`, or an explicit `-RepositoryPath`
- An authenticated GitHub CLI with access to `amir-ba/1`, `telekom/scale`, and the `amir-ba/scale` fork
- The required Copilot skills installed and discoverable with `copilot skill list`

The generated configuration targets `telekom/scale` and pushes issue-worker branches only to `amir-ba/scale`.

## Workflow

Each run acquires an orchestrator lock, reads up to 100 Project items, reconciles existing workers, and then considers up to 10 `Backlog` issues or pull requests. Candidates are ordered by `P0`, `P1`, `P2`, then creation time.

Triage is read-only and invokes these skills in order:

1. `scale-maintainer`
2. `github-project-triage`
3. `github-deep-review`

Eligible items must provide component/resource locks and a verification plan. Ineligible items receive a decision-ready comment and move to `Needs owner` without consuming a worker slot.

Eligible items move to `Autonomous` only after an isolated worktree is prepared. Issues start from `upstream/main`; pull requests are fetched from `refs/pull/<number>/head`. The worker invokes `scale-maintainer`, `stenciljs-component-development`, and `github-deep-review`. Issue workers may commit, push their `copilot/issue-...` branch to `amir-ba/scale`, and open a PR; PR workers are read-only and never modify, push, or replace contributor work.

## Guardrails

- The default capacity is five `Autonomous` cards. Cards claimed by someone else consume capacity but are not adopted.
- Locks from active owned workers prevent overlapping work.
- Worker shell access denies destructive Git commands, releases, publishing, Project mutations, and `gh pr merge`.
- Workers send a heartbeat every 30 seconds. Failed or stale workers retry until the configured three-attempt limit, then move to `Needs owner`.
- Only the orchestrator merges. It requires an unchanged worktree, the exact reported PR head, a non-draft mergeable PR against `main`, and passing `prettier`, `tslint`, `unit-tests`, `e2e-tests`, `visual-tests`, and `wrapper-build` checks. Valid PRs are squash-merged and their cards move to `Done`.

## Install And Run

Run the checks first:

```powershell
npm test
npm run check
```

Preview the default scheduler configuration without creating a task:

```powershell
npm run scheduler:whatif
```

Install a disabled 15-minute scheduled task:

```powershell
npm run scheduler:install
```

The installer writes its configuration, worker manifests, and logs beneath `%LOCALAPPDATA%\ScaleMaintainer\scale`. It defaults to the sibling checkout `..\scale`. For a one-worker canary or a different checkout:

```powershell
.\install-scheduler.ps1 -RepositoryPath C:\work\scale -MaxWorkers 1 -PassThru
```

Inspect the emitted JSON configuration, then preview a dispatcher run before enabling the task:

```powershell
node .\orchestrator.mjs --config <config-path> --dry-run --json
```

Enable the scheduled task only after that review:

```powershell
.\install-scheduler.ps1 -Enable
```

Use `-Uninstall` to remove the `Scale Maintainer Watch` task. The task uses `IgnoreNew` for overlapping invocations and runs with the current user's interactive token.

## Runtime State

The state directory contains `config.json`, an `orchestrator.lock`, `workers\*.json` manifests and results, and `logs\`. Scheduler output is appended to `logs\scheduler.log`; each dispatcher run also writes an `orchestrator-YYYY-MM-DD.log` entry.

The test suite uses temporary directories and does not install or enable a scheduled task.

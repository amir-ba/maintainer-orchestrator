---
name: github-project-triage
description: "Scale GitHub issue and PR triage: single-repository queue, CI, blockers, deep review, proof, and next actions. Use when triaging telekom/scale issues or pull requests."
---

# Scale GitHub Project Triage

Use this skill for `telekom/scale` GitHub issue and pull-request triage. It produces maintainer-facing, URL-first item cards: what each item is about, why it matters, fit, risk, evidence, blockers, and next action.

This skill is deliberately single-repository. Do not use RepoBar, enumerate owners, or expand to other repositories unless the user explicitly asks for cross-repository triage.

## Local Repository Gate

Before beginning local repository work, record the checkout state:

```bash
git status --short --branch
git branch --show-current
git log --oneline --decorate -20
git fetch origin
```

- Worktree state is evidence, not permission to discard work.
- On a clean `main` checkout, run `git pull --ff-only` before implementation or current-main reproduction.
- On a dirty or non-`main` checkout, do not pull, switch, stash, commit, reset, restore, or clean. Preserve the state and report it to the owner before any mutation.

## Weekly Triage Process

1. Confirm the repository is `telekom/scale`.
2. List the open issue and PR queues:

   ```bash
   gh issue list --repo telekom/scale --state open --limit 50 \
     --json number,title,author,labels,createdAt,updatedAt,url
   gh pr list --repo telekom/scale --state open --limit 50 \
     --json number,title,author,isDraft,reviewDecision,mergeStateStatus,createdAt,updatedAt,url
   ```

3. Read all owner or maintainer comments for items under consideration. Owner guidance overrides labels and ordinary triage judgment.
4. For queues of 10 or fewer items, inspect every issue and PR. For larger queues, inspect the highest-priority slice and state what was not expanded.
5. Use `github-deep-review` before implementation for every issue or PR proposed as an autonomous candidate, and for every PR before recommending approval, merge, rework, close, or implementation. Its root-cause, provenance, code-path, regression, accessibility, and public-API findings are required triage evidence.
6. When autonomous work creates or changes a patch, run `github-deep-review` again on the completed diff before committing, pushing, updating a PR, or recommending landing. Repair blocking findings and rerun the review until no actionable correctness, accessibility, regression, or public-API issue remains.
7. Classify each reviewed item as `Autonomous candidate`, `Needs owner`, or `Defer/close/supersede`.

## Required GitHub Evidence

Use `gh` for GitHub references:

```bash
gh issue view <number> --repo telekom/scale \
  --json number,title,author,body,comments,labels,createdAt,updatedAt,url

gh pr view <number> --repo telekom/scale \
  --json number,title,author,body,comments,reviews,files,commits,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,createdAt,updatedAt,url

gh pr diff <number> --repo telekom/scale --patch
```

For any item that could be acted on, establish enough detail to state:

- the reported behavior or proposed change;
- the affected package and user impact;
- whether current `main` reproduces the issue or already resolves it;
- root cause, or exactly why it is not yet established;
- CI, tests, visual-regression, and Storybook proof state;
- blockers, including conflicts, missing reproduction, unavailable access, or unresolved design direction.

## Scale Fit and Verification

Prioritize security, accessibility, regressions, broken installs/builds, component correctness, visual regressions, and clear bugs with a bounded proof path.

Assess impacted surfaces:

- `packages/components`: StencilJS component behavior, API compatibility, unit/E2E tests, Storybook, and visual tests.
- `packages/components-react`: generated React wrapper compatibility after public component API changes.
- `packages/design-tokens`: token provenance and consumer impact. Token changes belong in the token package and need a separate repository PR.
- `packages/storybook-vue`: documentation accuracy for active component APIs.
- `packages/visual-tests`: visual baseline coverage for rendering changes.
- `packages/components-angular` and `packages/components-vue`: deprecated; do not recommend code changes. Their CI builds must remain functional.

Reject or escalate proposals that introduce breaking public APIs, default-style regressions, undocumented token values, or new feature work in deprecated wrappers.

For changed component behavior, expected verification includes the smallest applicable combination of:

```bash
yarn format
yarn workspace @telekom/scale-components build
yarn workspace @telekom/scale-components test --spec --max-workers=8
yarn workspace @telekom/scale-components test --e2e --max-workers=8
yarn workspace @telekom/scale-visual-tests test:ci -u
```
- dependency updates need to update the yarn.lock file and the package.json both need to be pushed (sub dependencies are only fixed in the lock file)
- use yarn
Use visual baseline updates only when the rendered change is intentional and reviewed.

## Classification

### Autonomous Candidate

Recommend only when all are true:

- the change is compatible with existing public APIs and styles;
- `github-deep-review` establishes a bounded root cause and best fix;
- required tests, visual proof, and CI checks are available;
- no material design, accessibility, security, privacy, or token-contract decision remains.

### Needs Owner

Use when the item needs a new component, a breaking API or style change, token-contract decision, deprecation change, security/privacy judgment, unavailable live proof, or an unresolved design tradeoff.

Prepare all reversible evidence first. Include the exact decision, options, recommendation, and consequences.

### Ignore: for Defer, Close, or Supersede

Use when current `main` already fixes the issue, strong evidence proves duplication, the item is obsolete, or the request is incompatible with Scale’s maintenance rules. Do not comment, close, or mutate GitHub state without an explicit user request.

## Output

Return URL-first, maintainer-facing cards. Every surfaced issue or PR must start with its canonical GitHub URL.

```text
Repo: https://github.com/telekom/scale
Source: gh issue/pr list, item details, github-deep-review, CI, local source/tests where inspected

Autonomous candidates:
- https://github.com/telekom/scale/issues/123 - Title
  What: Plain-language behavior and affected package.
  Fit/Risk: Good; low|medium|high because ...
  Deep review: Root cause, provenance, best fix, and API/a11y result.
  Proof: Current-main repro, tests, visual/Storybook state, CI.
  Next: Exact implementation and verification action.

Needs owner:
- https://github.com/telekom/scale/pull/456 - Title
  Decision: Exact choice required and why it cannot be inferred.
  Evidence: Deep-review result, CI, tests, and remaining risk.
  Recommendation: Opinionated choice with rationale.

Defer/close/supersede:
- https://github.com/telekom/scale/issues/789 - Title
  Evidence: Why this action is supported.
  Next: Exact non-mutating or requested GitHub action.

Skipped:
- Reason items were not expanded.
```

## Autonomous Work Mode

When working on autonomous tasks, process one eligible item at a time:

1. Run `github-deep-review` and determine the root cause and best bounded fix.
2. Implement only after the item satisfies the Autonomous Candidate criteria.
3. Add the smallest meaningful regression coverage; update Storybook and visual baselines when the changed surface requires them.
4. Run the applicable checks and inspect exact-head CI.
5. Hand the completed diff to `github-deep-review`. Resolve actionable findings, then rerun the review until it finds no blocking correctness, accessibility, regression, or public-API issue.
6. Keep changes backward-compatible, use only `@telekom/design-tokens`, and never change deprecated Angular or Vue wrappers.
7. Commit using a conventional commit message, then push/open or update the PR only when authorized.
8. Return to clean, synchronized `main` before selecting the next item.

Do not work multiple tickets at once. If blocked, report the exact blocker, current branch/worktree state, evidence gathered, and the specific decision or access required.

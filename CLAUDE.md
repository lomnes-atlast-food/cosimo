# CLAUDE.md

`AGENTS.md` covers installing and using Cosimo as an end-user agent. This file covers developing it with Claude Code.

Maintainer-only notes live in `CLAUDE.local.md` (gitignored).

## Checks
`bun run lint`, `bun run typecheck`, `bun test` (`bun run check` also runs the sqld backend). After changing server schemas, regenerate the web API types with `bun run --cwd apps/web gen:api`. Each sqld test run leaks one `sqld` process (the preload's exit hook doesn't fire); kill the ones your run started.

Browser tests: `bun run build:web`, then `bun run e2e`. A fresh worktree has no web build, and without one every e2e test times out on "The web UI has not been built". Set `COSIMO_E2E_PORT` to run beside another e2e run. CI retries a serial file (such as `books.e2e.ts`) as a whole against the same database, so failures on the retry can be fallout; read the first attempt's error.

## Issues
An issue asks someone to do something. Don't open one that can't be acted on.

- **Bug reports carry evidence.** Include the failing run's link or the exact command, the error or log excerpt, the commit, and the steps to reproduce. For an intermittent failure, also say how often it happens (for example, 2 of the last 30 CI runs). A claim with no evidence, such as "occasionally flaky," isn't an issue yet.
- **Investigate before filing.** For a flaky test or crash, search the CI history for the same failure and rerun it locally to measure how often it happens. File the issue with what you found and a next step. If you can't reproduce it, don't file it.
- **Don't file "wait and see" issues.** "Re-check on the next release" or "upgrade once upstream fixes it" is not a next step. Fix it, work around it, or record why no action is needed (see Scanner findings).
- **Close what can't be verified.** If an open issue's bug can't be reproduced, comment with the investigation (what you checked and the results) and what evidence a new issue would need, then close it as not planned with the `invalid` label. Use `wontfix` only for a confirmed problem you've decided not to fix.

### Scanner findings
When `bun audit` or OSV flags an advisory that doesn't affect Cosimo (the vulnerable code never runs here), don't open a tracking issue that waits on an upstream fix. Add an ignore to `osv-scanner.toml` with an `ignoreUntil` date and a `reason` that stands alone: why Cosimo isn't affected and what would let the ignore go. If an issue already exists, comment with that reasoning and close it as not planned. When the date passes, CI fails: check again, then fix, extend, or remove the ignore.

## Worktrees
Worktrees live next to the repo in `../cosimo-worktrees/<issue>-<slug>`, one per change. Each has its own `node_modules`, so run `bun install` in a new worktree before any checks.

## Plan, then hand off to a subagent to build it

For non-trivial changes: plan in the main session, have the `implementer` subagent (`.claude/agents/implementer.md`) build it, then review in the main session. This keeps file dumps and test output out of the main context, and uses a cheaper model where judgment matters less.

### While planning
- **Verify what exploration subagents report before relying on it.** Open the files they cite. Explore reports have described files and code that don't exist here.
- End every plan file with a **Handoff** section written for a builder that has none of this conversation:
  - **Implementer and model.** Pick the model with this rubric, and give the size (files, areas) and a one-line reason:
    - `haiku`: mechanical edits with exact instructions, one or two files, no design choices (renames, copy changes, config).
    - `sonnet` (the default): multi-file features that follow patterns already in the codebase, where the plan has pinned down the approach and the key facts. Most server + web + test work lands here.
    - `opus`: the plan can't pin down the approach, or correctness is subtle and costly to get wrong (ledger math, migrations and data backfills, concurrency, auth and security), or the refactor is large and cross-cutting.
  - **Confirmed facts.** Paths, functions, and line numbers you checked yourself. Label anything inferred.
  - **Decisions** from the Q&A, stated as rules.
  - **Done criteria.** The checks above, plus any specific tests. No commits.
  - **Report back.** Changed files, check results, deviations from the plan, and anything the reviewer should look at first.
- Before calling ExitPlanMode, tell the user in one line that the subagent inherits the session's permission mode, so they should pick "accept edits" or auto when they approve. A plan-mode or manual-approval session stalls a background builder.

### After the user approves
Every approved plan ships through an issue and a PR, so the work is documented on GitHub (`lomnes-atlast-food/cosimo`). The user has authorized every step below for approved plans; don't ask again. Don't wait to be asked:

1. **Issue.** Search for an existing one first (`gh issue list --search "<keywords>" --state all`). If none fits, create it with `gh issue create`. The title is the change; the body is the plan's Context section plus the user's decisions. Note the number, `#N`.
2. **Worktree.** Each change gets its own worktree, so several can be in progress at once:
   ```sh
   git fetch -q origin
   git worktree add ../cosimo-worktrees/<N>-<slug> -b <N>-<slug> origin/main
   cd ../cosimo-worktrees/<N>-<slug> && bun install
   ```
   Do all further work there. Never edit or commit in the main checkout.
3. **Build.** Launch `implementer` in the background with:
   - the worktree path, which it must work in;
   - the plan path and the Handoff section's contents;
   - the model the plan chose, passed as the `model` parameter.

   Tell the user it's running and which model it uses. Don't poll: you are notified when it finishes. If the user asks which model is running, grep the task's output file for `"model":"` and count; don't read the whole file.
4. **Review.** When it reports, review the diff in the worktree yourself; don't trust the report. Rerun lint, typecheck, and tests there, and fix small problems directly. If its final message is an interim note ("waiting for…") rather than the report, don't wait on it: review the diff, run the checks yourself, and stop the agent once you have.
5. **Commit.** Commit in the worktree in this repo's style: an `area: summary` subject, a body that says what changed and why, and a footer `Closes #N`. Split into several commits only when the parts stand alone (for example, a code change and an unrelated config change).
6. **PR.** `git push -u origin <branch>`, then `gh pr create --base main --title "<subject>" --body "<body>"`. Pick the release label with `gh pr edit <PR> --add-label`. Patch is the default and needs no label: it covers fixes and incremental features, such as new tools or options in an existing area (PR #32 should have been a patch). Use `release:minor` only for a new area of the product or a change users must act on (a migration step, a changed config), `release:major` only for a breaking change, and `release:skip` for a docs- or config-only change. The body covers:
   - what changed and why;
   - the check results;
   - what you fixed in review;
   - anything left unverified;
   - `Closes #N`.
7. **Record the review.** GitHub doesn't let a PR's author approve it, and `gh` runs as the repo owner, so `gh pr review --approve` fails with `Can not approve your own pull request` (confirmed on PR #3). Record the review with `gh pr review <PR> --comment --body "<review summary>"`: what you checked, what you fixed, and the check results.
8. **Merge.** First run `gh pr checks <PR>` and read every line that isn't `pass`. Merge only if nothing fails, or if each failure also fails on `main` and has an issue named in the PR. Then run `gh pr merge <PR> --rebase`. Rebase keeps `main` linear and preserves the commit messages. Don't pass `--delete-branch`: the worktree still has the branch checked out, so the local delete fails, and then `gh` skips the remote delete too (#4). After merging, watch the Release run it triggers.
9. **Clean up**, from the main checkout, in this order:
   ```sh
   git worktree remove ../cosimo-worktrees/<N>-<slug>
   git branch -D <N>-<slug>
   git push origin --delete <N>-<slug>
   git pull --ff-only --prune
   ```
   Then confirm the issue is closed, and that `git worktree list` and `git branch -a` show no leftovers.
10. **Report** the issue and PR links, what was built, what you fixed in review, the check results, anything left unverified, such as a manual check in the browser, and the released version (from the Release tag).

If a step fails (auth, a push rejected, a merge conflict), stop, and tell the user the exact error and which state it left behind. Don't force-push or bypass checks.

### Example Handoff (the Categorize filters change, September 2026)
> **Implementer:** `implementer` on `sonnet`. Roughly 13 files across server services and routes, dashboard, MCP, web pages, a new UI component, and tests. It follows existing patterns (zod-openapi routes, `listBankTxns` filters, `Tabs` styling). The one design point, a single bucket `CASE` expression, is decided in the plan, so opus isn't needed.
> **Confirmed facts:**
> - `listBankAccounts().unreviewed` is at `services/banking.ts:69-77` and only checks `status = 'new'`.
> - `assertReviewable` (`:305`) blocks pending rows; keep that.
> - Register the new `/counts` route before `/{txnId}`.
> **Decisions:**
> - The page opens on All; links from "to categorize" counts pass `status=todo`.
> - Rows waiting in the review queue leave the to-categorize counts.
> - Search sits in the list toolbar, not next to the account selector.
> **Done:** lint, typecheck, `bun test`, and `gen:api` rerun. No commits.

In review, the main session found and fixed a doubled-parentheses amount the builder had introduced, plus a misleading MCP description. That's why step 3 exists.

# Scheduled failure issue reporter

This composite action creates, updates, or resolves issues for scheduled workflow failures.
The action identifies the failing job and step through `listJobsForWorkflowRun`,
downloads the workflow-run log archive, and keeps a sanitized 40-line excerpt. Issues
are keyed by the hidden body marker and the `ci-failure` label; subsequent failures
comment on the open issue, and a successful run comments and closes it as completed.

## Workflows

- **Nightly testnet smoke** (`testnet-smoke.yml`): Runs after the smoke test job and manages the tracking issue (`nightly-smoke`).
- **Weekly fuzz** (`fuzz.yml`): Classified by evidence into real crashes vs broken CI, deduplicates issues on repeated failures, and auto-resolves when fuzzing completes cleanly.

## Local test

From the repository root, run:

```sh
node --test .github/actions/scheduled-failure-issue/test.cjs
```

## Actions verification

After pushing the change, open the workflow on the branch containing this change
and use **Run workflow**. For a temporary failure test, add a boolean `force_fail`
input (default `false`) to `workflow_dispatch` and add this step at the start of
that workflow's test job:

```yaml
- name: Temporary dedupe test failure
  if: ${{ inputs.force_fail }}
  run: exit 1
```

Push this temporary test-only change, then dispatch the workflow twice with
`force_fail` set to `true`:

1. The first failed run should create exactly one issue with the workflow's
   stable marker, `ci-failure` label, failed step, and log excerpt.
2. The second failed run should add a comment to that same issue, without
   creating another one.
3. Remove the temporary input and failure step, push the revert, and dispatch
   once more. The reporter should comment with the passing run URL and close the
   issue as completed.

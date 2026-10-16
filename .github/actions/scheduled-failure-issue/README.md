# Scheduled failure issue reporter

Both scheduled workflows call this composite action from one reporter job after
the test job completes. The action identifies the failing job and step through
`listJobsForWorkflowRun`, downloads the workflow-run log archive, and keeps a
sanitized 40-line excerpt. Issues are keyed by the hidden body marker and the
`ci-failure` label; subsequent failures comment on the open issue, and a
successful run comments and closes it as completed.

## Local test

From the repository root, run:

```sh
node --test .github/actions/scheduled-failure-issue/test.cjs
```

## Actions verification

After pushing the change, open each workflow on the branch containing this
change and use **Run workflow**. For a temporary failure test, add a boolean
`force_fail` input (default `false`) to `workflow_dispatch` and add this step at
the start of that workflow's test job:

```yaml
- name: Temporary dedupe test failure
  if: ${{ inputs.force_fail }}
  run: exit 1
```

Push this temporary test-only change, then dispatch each workflow twice with
`force_fail` set to `true`:

1. The first failed run should create exactly one issue with the workflow's
   stable marker, `ci-failure` label, failed step, and log excerpt.
2. The second failed run should add a comment to that same issue, without
   creating another one.
3. Remove the temporary input and failure step, push the revert, and dispatch
   once more. The reporter should comment with the passing run URL and close the
   issue as completed.

Repeat for `testnet-smoke.yml` and `fuzz.yml`. For fuzz, either matrix job may
fail; the single reporter job runs after the matrix and files one issue for the
workflow key. Do not leave the forced failure in the workflow after testing.

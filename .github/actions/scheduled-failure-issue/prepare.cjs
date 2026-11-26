'use strict';

async function prepareFailure({ github, context, core }) {
  const { data } = await github.rest.actions.listJobsForWorkflowRun({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: context.runId,
    per_page: 100,
  });
  const failedJob = data.jobs.find((job) => job.conclusion === 'failure');
  if (!failedJob) {
    throw new Error(`Workflow run ${context.runId} failed but has no failed job.`);
  }
  const failedStep = failedJob.steps?.find((step) => step.conclusion === 'failure');
  core.setOutput('job_name', failedJob.name);
  core.setOutput('step_name', failedStep?.name || 'Failed job (no failed step reported)');
}

module.exports = { prepareFailure };

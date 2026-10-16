'use strict';

const LABEL = 'ci-failure';
const LABEL_COLOR = 'd876e3';
const BODY_LIMIT = 60_000;
const LOG_LIMIT = 12_000;
const LOG_LINES = 40;

function markerFor(key) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
    throw new Error(`Invalid scheduled failure key: ${key}`);
  }
  return `<!-- scheduled-failure-key: ${key} -->`;
}

function extractError(logText) {
  const clean = String(logText || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:secret|token|password|api[_-]?key)\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
  const tail = clean.split('\n').slice(-LOG_LINES).join('\n');
  return tail.length > LOG_LIMIT ? `[...truncated...]\n${tail.slice(-LOG_LIMIT)}` : tail;
}

async function listOpenIssues(github, owner, repo) {
  const issues = [];
  for (let page = 1; ; page += 1) {
    const { data } = await github.rest.issues.listForRepo({
      owner,
      repo,
      state: 'open',
      labels: LABEL,
      per_page: 100,
      page,
    });
    issues.push(...data);
    if (data.length < 100) break;
  }
  return issues;
}

async function ensureLabel(github, owner, repo) {
  try {
    await github.rest.issues.getLabel({ owner, repo, name: LABEL });
  } catch (error) {
    if (error.status !== 404) throw error;
    try {
      await github.rest.issues.createLabel({
        owner,
        repo,
        name: LABEL,
        color: LABEL_COLOR,
        description: 'Open issue tracking a scheduled workflow failure',
      });
    } catch (createError) {
      if (createError.status !== 422) throw createError;
      await github.rest.issues.getLabel({ owner, repo, name: LABEL });
    }
  }
}

function failureDetails({ context, jobName, stepName, errorLog, whatToCheck }) {
  const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  const error = extractError(errorLog) || 'No job log excerpt was available.';
  return [
    `**Workflow:** ${context.workflow}`,
    `**Run:** ${runUrl}`,
    `**Commit:** \`${context.sha}\``,
    `**Branch:** \`${context.ref.replace(/^refs\/heads\//, '')}\``,
    `**Timestamp:** ${new Date().toISOString()}`,
    `**Failed job:** ${jobName || 'Unknown'}`,
    `**Failing step:** ${stepName || 'Unknown'}`,
    '',
    '### Error (last log lines)',
    '```text',
    error.replace(/```/g, '` ` `'),
    '```',
    '',
    '### What to check',
    whatToCheck,
    '',
    'Please investigate the failing step and use the log excerpt above to reproduce or diagnose the failure. Update this issue with the cause and resolution.',
  ].join('\n');
}

async function reportScheduledFailure(options) {
  const {
    github, context, core, key, status, titlePrefix, whatToCheck,
    extraLabels = '', jobName, stepName, errorLog,
  } = options;
  if (!['success', 'failure'].includes(status)) {
    core.info(`Scheduled failure reporter skipped for status "${status}".`);
    return;
  }

  const { owner, repo } = context.repo;
  const marker = markerFor(key);
  const existing = (await listOpenIssues(github, owner, repo))
    .find((issue) => issue.body?.includes(marker));
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;

  if (status === 'success') {
    if (!existing) {
      core.info(`No open scheduled failure issue for "${key}".`);
      return;
    }
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: existing.number,
      body: `Passed in run ${runUrl}`,
    });
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: existing.number,
      state: 'closed',
      state_reason: 'completed',
    });
    core.info(`Closed scheduled failure issue #${existing.number}.`);
    return;
  }

  await ensureLabel(github, owner, repo);
  const details = failureDetails({ context, jobName, stepName, errorLog, whatToCheck });
  const body = [
    `## ${titlePrefix}`,
    '',
    marker,
    '',
    details,
  ].join('\n').slice(0, BODY_LIMIT);
  if (existing) {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: existing.number,
      body: details.slice(0, BODY_LIMIT),
    });
    core.info(`Updated existing scheduled failure issue #${existing.number}.`);
    return;
  }

  const labels = [LABEL, ...extraLabels.split(',').map((label) => label.trim()).filter(Boolean)];
  const { data: issue } = await github.rest.issues.create({
    owner,
    repo,
    title: `${titlePrefix}: ${context.workflow}`,
    body,
    labels,
  });
  core.info(`Created scheduled failure issue #${issue.number}.`);
}

module.exports = {
  extractError,
  markerFor,
  reportScheduledFailure,
};

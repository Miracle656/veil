'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractError, reportScheduledFailure } = require('./report.cjs');
const { prepareFailure } = require('./prepare.cjs');

function mockOctokit(openIssues = []) {
  const calls = { comments: [], creates: [], updates: [], labels: [] };
  let labelExists = false;
  const github = {
    rest: {
      issues: {
        getLabel: async () => {
          if (!labelExists) {
            const error = new Error('Not found');
            error.status = 404;
            throw error;
          }
        },
        createLabel: async (label) => {
          labelExists = true;
          calls.labels.push(label);
        },
        listForRepo: async () => ({ data: openIssues.filter((issue) => issue.state === 'open') }),
        create: async (issue) => {
          calls.creates.push(issue);
          return { data: { number: 42 } };
        },
        createComment: async (comment) => calls.comments.push(comment),
        update: async (update) => calls.updates.push(update),
      },
    },
  };
  return { github, calls };
}

const context = {
  repo: { owner: 'owner', repo: 'repo' },
  runId: 123,
  workflow: 'Nightly smoke',
  sha: 'deadbeef',
  ref: 'refs/heads/main',
  serverUrl: 'https://github.com',
};
const options = (github, status, additional = {}) => ({
  github,
  context,
  core: { info() {} },
  key: 'nightly-smoke',
  status,
  titlePrefix: 'Nightly smoke failed',
  whatToCheck: '- Check testnet RPC and Horizon.',
  jobName: 'smoke',
  stepName: 'Send payment',
  errorLog: 'payment failed',
  ...additional,
});
const openIssue = {
  number: 7,
  state: 'open',
  body: '<!-- scheduled-failure-key: nightly-smoke -->',
};

test('failure metadata comes from the failed job and step', async () => {
  const outputs = {};
  const github = {
    rest: {
      actions: {
        listJobsForWorkflowRun: async () => ({
          data: {
            jobs: [
              { name: 'passing job', conclusion: 'success', steps: [] },
              {
                name: 'fuzz target',
                conclusion: 'failure',
                steps: [
                  { name: 'checkout', conclusion: 'success' },
                  { name: 'Run fuzzer', conclusion: 'failure' },
                ],
              },
            ],
          },
        }),
      },
    },
  };
  await prepareFailure({
    github,
    context: { repo: { owner: 'owner', repo: 'repo' }, runId: 123 },
    core: { setOutput: (name, value) => { outputs[name] = value; } },
  });
  assert.deepEqual(outputs, { job_name: 'fuzz target', step_name: 'Run fuzzer' });
});

test('first failure creates one labelled issue with the marker', async () => {
  const { github, calls } = mockOctokit();
  await reportScheduledFailure(options(github, 'failure'));
  assert.equal(calls.creates.length, 1);
  assert.match(calls.creates[0].body, /scheduled-failure-key: nightly-smoke/);
  assert.match(calls.creates[0].body, /\*\*Workflow:\*\* Nightly smoke/);
  assert.match(calls.creates[0].body, /actions\/runs\/123/);
  assert.match(calls.creates[0].body, /\*\*Commit:\*\* `deadbeef`/);
  assert.match(calls.creates[0].body, /\*\*Branch:\*\* `main`/);
  assert.match(calls.creates[0].body, /\*\*Timestamp:\*\*/);
  assert.match(calls.creates[0].body, /Failing step:\*\* Send payment/);
  assert.match(calls.creates[0].body, /payment failed/);
  assert.match(calls.creates[0].body, /What to check/);
  assert.deepEqual(calls.creates[0].labels, ['ci-failure']);
  assert.equal(calls.labels.length, 1);
});

test('second failure comments on the existing issue without creating one', async () => {
  const { github, calls } = mockOctokit([openIssue]);
  await reportScheduledFailure(options(github, 'failure'));
  assert.equal(calls.creates.length, 0);
  assert.equal(calls.comments.length, 1);
  assert.equal(calls.comments[0].issue_number, 7);
  assert.match(calls.comments[0].body, /Failing step:\*\* Send payment/);
  assert.match(calls.comments[0].body, /payment failed/);
});

test('success comments and closes the open issue as completed', async () => {
  const { github, calls } = mockOctokit([openIssue]);
  await reportScheduledFailure(options(github, 'success'));
  assert.match(calls.comments[0].body, /Passed in run https:\/\/github.com\/owner\/repo\/actions\/runs\/123/);
  assert.equal(calls.updates[0].state, 'closed');
  assert.equal(calls.updates[0].state_reason, 'completed');
});

test('success without an open issue does nothing', async () => {
  const { github, calls } = mockOctokit();
  await reportScheduledFailure(options(github, 'success'));
  assert.equal(calls.creates.length, 0);
  assert.equal(calls.comments.length, 0);
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.labels.length, 0);
});

test('error excerpt is ANSI-stripped, redacted, and limited to the final 40 lines', () => {
  const lines = Array.from({ length: 55 }, (_, index) => `line-${index + 1}`);
  lines[54] = '\u001b[31msecret=example-secret\u001b[0m';
  const excerpt = extractError(lines.join('\n'));
  assert.doesNotMatch(excerpt, /\u001b/);
  assert.doesNotMatch(excerpt, /example-secret/);
  assert.match(excerpt, /\[REDACTED\]/);
  assert.doesNotMatch(excerpt, /line-15\n/);
  assert.match(excerpt, /line-16/);
  assert.match(excerpt, /line-54/);
  assert.ok(excerpt.split('\n').length <= 40);

  const long = extractError('x'.repeat(15_000));
  assert.ok(long.length <= 12_000 + '[...truncated...]\n'.length);
  assert.ok(long.startsWith('[...truncated...]'));
});

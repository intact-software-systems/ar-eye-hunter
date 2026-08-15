import { describe, expect, it } from 'vitest';

import { runPullRequestDeliveryCommand } from '../../../../scripts/pull-request-delivery.mjs';

const passingCheck = {
  __typename: 'CheckRun',
  name: 'Branch Release Gate result',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  startedAt: '2026-08-14T20:00:00Z',
  completedAt: '2026-08-14T20:01:00Z',
  detailsUrl: 'https://github.com/example/repository/actions/runs/1',
  workflowName: 'Branch Release Gate',
};

const openPullRequest = {
  number: 222,
  url: 'https://github.com/example/repository/pull/222',
  state: 'OPEN',
  mergedAt: null,
  isDraft: false,
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [passingCheck],
  reviewDecision: 'REVIEW_REQUIRED',
  autoMergeRequest: null,
};

describe('pull request delivery command', () => {
  it('lists only status and ready in help without reading GitHub', async () => {
    const github = createGithubFixture([]);

    const result = await runCommand(['--help'], github);

    expect(result.action).toBe('HELP');
    expect(result.output).toEqual([
      'Usage: npm run pr:delivery -- <status|ready>',
      '  status  Read the current pull request and report the next action.',
      '  ready   Mark a draft ready and arm native auto-merge after approval.',
    ]);
    expect(github.calls).toEqual([]);
  });

  it('opens a draft when the current branch has no pull request', async () => {
    const github = createGithubFixture([], {
      pullRequestError: 'no pull requests found for branch codex/example',
    });

    const result = await runCommand(['status'], github);

    expect(result.action).toBe('OPEN_DRAFT');
    expect(result.output).toEqual([
      'Action: OPEN_DRAFT',
      'Next: Publish a coherent commit and open one draft pull request.',
    ]);
    expect(github.mutations).toEqual([]);
  });

  it('reads the current branch pull request and reports its live action', async () => {
    const github = createGithubFixture([{ ...openPullRequest, mergeStateStatus: 'BEHIND' }]);

    const result = await runCommand(['status'], github);

    expect(result.action).toBe('AWAIT_REVIEW_OR_ADMIN_MERGE');
    expect(result.output).toEqual([
      'PR #222 https://github.com/example/repository/pull/222',
      'Action: AWAIT_REVIEW_OR_ADMIN_MERGE',
      'Next: Await native review or merge intentionally through GitHub as an administrator.',
    ]);
    expect(github.calls).toHaveLength(2);
    expect(github.calls[0]?.arguments.slice(0, 2)).toEqual(['pr', 'view']);
    expect(github.calls[1]?.arguments).toEqual(['repo', 'view', '--json', 'defaultBranchRef']);

    const requestedFields = github.calls[0]?.arguments[3]?.split(',') ?? [];
    expect(requestedFields).toEqual(
      expect.arrayContaining([
        'number',
        'url',
        'state',
        'mergedAt',
        'isDraft',
        'baseRefName',
        'mergeable',
        'mergeStateStatus',
        'statusCheckRollup',
        'reviewDecision',
        'autoMergeRequest',
      ]),
    );
    expect(github.calls.flatMap((call) => call.arguments)).not.toContain('222');
    expect(github.calls.map(toCommandText).join('\n')).not.toMatch(
      /sha|digest|plan|workflow run|reviewer/i,
    );
  });

  it('keeps unrelated pull requests isolated because each branch resolves its own live PR', async () => {
    const firstGithub = createGithubFixture([{ ...openPullRequest, number: 101 }]);
    const secondGithub = createGithubFixture([
      { ...openPullRequest, number: 102, reviewDecision: 'APPROVED' },
    ]);

    const first = await runCommand(['status'], firstGithub);
    const second = await runCommand(['status'], secondGithub);

    expect(first.output[0]).toContain('PR #101');
    expect(first.output.join('\n')).not.toContain('102');
    expect(second.output[0]).toContain('PR #102');
    expect(second.output.join('\n')).not.toContain('101');
    for (const github of [firstGithub, secondGithub]) {
      expect(github.calls.flatMap((call) => call.arguments)).not.toEqual(
        expect.arrayContaining(['101', '102']),
      );
      expect(github.mutations).toEqual([]);
    }
  });

  it('reports a real conflict before performing readiness mutations', async () => {
    const github = createGithubFixture([
      {
        ...openPullRequest,
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        statusCheckRollup: [{ ...passingCheck, status: 'IN_PROGRESS', conclusion: '' }],
      },
    ]);

    const result = await runCommand(['ready'], github);

    expect(result.action).toBe('REPAIR_CONFLICT');
    expect(github.mutations).toEqual([]);
  });

  it('marks a draft ready without arming auto-merge before approval', async () => {
    const github = createGithubFixture([{ ...openPullRequest, isDraft: true }, openPullRequest]);

    const result = await runCommand(['ready'], github);

    expect(result.action).toBe('AWAIT_REVIEW_OR_ADMIN_MERGE');
    expect(github.mutations).toEqual([['pr', 'ready']]);
    expect(github.calls.map((call) => call.arguments.slice(0, 2))).toEqual([
      ['pr', 'view'],
      ['repo', 'view'],
      ['pr', 'ready'],
      ['pr', 'view'],
    ]);
  });

  it('does not arm auto-merge before approval', async () => {
    const github = createGithubFixture([openPullRequest]);

    const result = await runCommand(['ready'], github);

    expect(result.action).toBe('AWAIT_REVIEW_OR_ADMIN_MERGE');
    expect(github.mutations).toEqual([]);
  });

  it('does not arm auto-merge while approval and the required check are pending', async () => {
    const github = createGithubFixture([
      {
        ...openPullRequest,
        statusCheckRollup: [{ ...passingCheck, status: 'IN_PROGRESS', conclusion: '' }],
      },
    ]);

    const result = await runCommand(['ready'], github);

    expect(result.action).toBe('WAIT_CI');
    expect(github.mutations).toEqual([]);
  });

  it('does not arm auto-merge while the required check is failing', async () => {
    const github = createGithubFixture([
      {
        ...openPullRequest,
        reviewDecision: 'APPROVED',
        statusCheckRollup: [{ ...passingCheck, conclusion: 'FAILURE' }],
      },
    ]);

    const result = await runCommand(['ready'], github);

    expect(result.action).toBe('REPAIR_CHECK');
    expect(github.mutations).toEqual([]);
  });

  it('performs no mutation when the pull request is already ready and armed', async () => {
    const github = createGithubFixture([
      {
        ...openPullRequest,
        autoMergeRequest: {
          enabledAt: '2026-08-14T20:00:00Z',
          mergeMethod: 'SQUASH',
          enabledBy: { login: 'developer' },
        },
      },
    ]);

    const result = await runCommand(['ready'], github);

    expect(result.action).toBe('AWAIT_REVIEW_OR_ADMIN_MERGE');
    expect(github.mutations).toEqual([]);
  });

  it('does not claim approval while native review is missing', async () => {
    const github = createGithubFixture([
      {
        ...openPullRequest,
        autoMergeRequest: {
          enabledAt: '2026-08-14T20:00:00Z',
          mergeMethod: 'SQUASH',
          enabledBy: { login: 'developer' },
        },
      },
    ]);

    const result = await runCommand(['status'], github);

    expect(result.action).toBe('AWAIT_REVIEW_OR_ADMIN_MERGE');
    expect(result.output).toEqual([
      'PR #222 https://github.com/example/repository/pull/222',
      'Action: AWAIT_REVIEW_OR_ADMIN_MERGE',
      'Next: Await native review, or disable PR auto-merge before an intentional ' +
        'administrator merge.',
    ]);
    expect(result.output.join('\n')).not.toMatch(/approved|receipt|evidence/i);
  });

  it('treats merged as terminal without any mutation', async () => {
    const github = createGithubFixture([
      {
        ...openPullRequest,
        state: 'CLOSED',
        mergedAt: '2026-08-14T20:00:00Z',
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        statusCheckRollup: [{ ...passingCheck, conclusion: 'FAILURE' }],
      },
    ]);

    const result = await runCommand(['ready'], github);

    expect(result.action).toBe('DONE');
    expect(result.output).toEqual([
      'PR #222 https://github.com/example/repository/pull/222',
      'Action: DONE',
      'Terminal: GitHub reports this pull request merged; no governance action is permitted.',
    ]);
    expect(result.output.join('\n')).not.toMatch(/archive|receipt|plan|refresh|rebase/iu);
    expect(github.mutations).toEqual([]);
  });

  it('stops on a closed unmerged pull request without reopening it', async () => {
    const github = createGithubFixture([{ ...openPullRequest, state: 'CLOSED' }]);

    const result = await runCommand(['ready'], github);

    expect(result.action).toBe('STOP_CLOSED');
    expect(github.mutations).toEqual([]);
  });

  it('normalizes an in-progress check to WAIT_CI', async () => {
    const github = createGithubFixture([
      {
        ...openPullRequest,
        statusCheckRollup: [{ ...passingCheck, status: 'IN_PROGRESS', conclusion: '' }],
      },
    ]);

    const result = await runCommand(['status'], github);

    expect(result.action).toBe('WAIT_CI');
  });

  it('normalizes a failed check to REPAIR_CHECK', async () => {
    const github = createGithubFixture([
      {
        ...openPullRequest,
        statusCheckRollup: [{ ...passingCheck, status: 'COMPLETED', conclusion: 'FAILURE' }],
      },
    ]);

    const result = await runCommand(['status'], github);

    expect(result.action).toBe('REPAIR_CHECK');
  });

  it('ignores unrelated failures after the stable required result passes', async () => {
    const github = createGithubFixture([
      {
        ...openPullRequest,
        statusCheckRollup: [
          passingCheck,
          {
            __typename: 'CheckRun',
            name: 'Retired review evidence',
            status: 'COMPLETED',
            conclusion: 'FAILURE',
            detailsUrl: 'https://github.com/example/repository/actions/runs/2',
            workflowName: 'Retired workflow',
          },
        ],
      },
    ]);

    const result = await runCommand(['status'], github);

    expect(result.action).toBe('AWAIT_REVIEW_OR_ADMIN_MERGE');
  });

  it('waits when the stable required result has not been published', async () => {
    const github = createGithubFixture([
      {
        ...openPullRequest,
        statusCheckRollup: [
          {
            __typename: 'CheckRun',
            name: 'Unrelated successful check',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            detailsUrl: 'https://github.com/example/repository/actions/runs/3',
            workflowName: 'Unrelated workflow',
          },
        ],
      },
    ]);

    const result = await runCommand(['status'], github);

    expect(result.action).toBe('WAIT_CI');
  });

  it('uses the newest stable result after GitHub reruns the same revision', async () => {
    const github = createGithubFixture([
      {
        ...openPullRequest,
        statusCheckRollup: [
          {
            ...passingCheck,
            status: 'COMPLETED',
            conclusion: 'FAILURE',
            startedAt: '2026-08-14T20:00:00Z',
            completedAt: '2026-08-14T20:01:00Z',
          },
          {
            ...passingCheck,
            startedAt: '2026-08-14T21:00:00Z',
            completedAt: '2026-08-14T21:01:00Z',
          },
        ],
      },
    ]);

    const result = await runCommand(['status'], github);

    expect(result.action).toBe('AWAIT_REVIEW_OR_ADMIN_MERGE');
  });

  it('falls back to administrator merge when GitHub cannot arm auto-merge', async () => {
    const github = createGithubFixture([{ ...openPullRequest, reviewDecision: 'APPROVED' }], {
      autoMergeError: 'GraphQL: Pull request auto-merge is not allowed',
    });

    const result = await runCommand(['ready'], github);

    expect(result.action).toBe('AWAIT_REVIEW_OR_ADMIN_MERGE');
    expect(result.errors).toEqual(['GraphQL: Pull request auto-merge is not allowed']);
    expect(github.mutations).toEqual([['pr', 'merge', '--auto', '--squash']]);
  });
});

interface GithubCall {
  readonly executable: string;
  readonly arguments: readonly string[];
}

interface GithubFixture {
  readonly calls: GithubCall[];
  readonly mutations: string[][];
  readonly execFile: (
    executable: string,
    arguments_: readonly string[],
    options: { readonly encoding: 'utf8' },
  ) => string;
}

interface GithubFixtureConfig {
  readonly autoMergeError?: string;
  readonly pullRequestError?: string;
}

function createGithubFixture(
  pullRequests: readonly (typeof openPullRequest)[],
  config: GithubFixtureConfig = {},
): GithubFixture {
  const calls: GithubCall[] = [];
  const mutations: string[][] = [];
  let pullRequestReadIndex = 0;

  return {
    calls,
    mutations,
    execFile(executable, arguments_, options) {
      expect(options).toEqual({ encoding: 'utf8' });
      calls.push({ executable, arguments: [...arguments_] });

      const operation = arguments_.slice(0, 2).join(' ');
      if (executable !== 'gh') {
        throw new Error(`Unexpected executable: ${executable}`);
      }
      if (operation === 'pr view') {
        if (config.pullRequestError !== undefined) {
          throw Object.assign(new Error(config.pullRequestError), {
            stderr: config.pullRequestError,
          });
        }
        const pullRequest = pullRequests[Math.min(pullRequestReadIndex, pullRequests.length - 1)];
        pullRequestReadIndex += 1;
        return JSON.stringify(pullRequest);
      }
      if (operation === 'repo view') {
        return JSON.stringify({ defaultBranchRef: { name: 'main' } });
      }
      if (operation === 'pr ready') {
        mutations.push([...arguments_]);
        return '';
      }
      if (operation === 'pr merge') {
        mutations.push([...arguments_]);
        if (config.autoMergeError !== undefined) {
          throw Object.assign(new Error(config.autoMergeError), {
            stderr: config.autoMergeError,
          });
        }
        return '';
      }
      throw new Error(`Unexpected GitHub operation: ${operation}`);
    },
  };
}

async function runCommand(arguments_: readonly string[], github: GithubFixture) {
  const output: string[] = [];
  const errors: string[] = [];
  const action = await runPullRequestDeliveryCommand(arguments_, {
    execFile: github.execFile,
    writeOutput: (line) => output.push(line),
    writeError: (line) => errors.push(line),
  });

  return { action, output, errors };
}

function toCommandText(call: GithubCall): string {
  return [call.executable, ...call.arguments].join(' ');
}

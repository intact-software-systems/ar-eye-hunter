import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeSha256 } from '../../../../scripts/governance-decisions/canonical-json.mjs';
import { decodeGovernanceDecisionCommand } from '../../../../scripts/governance-decisions/governance-decision-command.mjs';
import {
  createGovernanceDecisionFixturePlanRecord,
  toGovernanceDecisionFixturePlanMarkdown,
} from './governance-decision-fixture';

const fixtureRoots: string[] = [];
const commandPath = path.resolve('scripts/governance-decisions.mjs');

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('governance decision command', () => {
  it('decodes all five public command names with exact options', () => {
    expect(
      decodeGovernanceDecisionCommand(['preview', '--request', 'request.json', '--repo', '/repo']),
    ).toEqual({ command: 'preview', requestPath: 'request.json', repoRoot: '/repo' });
    expect(
      decodeGovernanceDecisionCommand([
        'verify-commit',
        '--commit',
        '1'.repeat(40),
        '--repo',
        '/repo',
      ]),
    ).toEqual({
      command: 'verify-commit',
      commitOid: '1'.repeat(40),
      repoRoot: '/repo',
    });
    expect(decodeGovernanceDecisionCommand(['apply', '--request', 'request.json'])).toEqual({
      command: 'apply',
      requestPath: 'request.json',
      repoRoot: process.cwd(),
    });
    expect(decodeGovernanceDecisionCommand(['publish-blob', '--file', 'plan.md'])).toEqual({
      command: 'publish-blob',
      path: 'plan.md',
      repoRoot: process.cwd(),
    });
    expect(
      decodeGovernanceDecisionCommand(['publish-request', '--request', 'request.json']),
    ).toEqual({
      command: 'publish-request',
      requestPath: 'request.json',
      repoRoot: process.cwd(),
    });
    expect(() => decodeGovernanceDecisionCommand(['preview', '--unknown', 'value'])).toThrow(
      'unsupported option: --unknown',
    );
  });

  it('previews a deterministic local transition without mutating the repository', () => {
    const fixture = createRepositoryFixture();
    const planContent = readFileSync(path.join(fixture.root, fixture.planPath));
    const requestPath = path.join(fixture.root, 'request.json');
    writeFileSync(
      requestPath,
      JSON.stringify({
        schemaVersion: 'governance-decision-request-v1',
        operation: 'plan.cancel',
        repository: 'intact-software-systems/ar-eye-hunter',
        defaultBranch: 'main',
        expectedHeadOid: fixture.headOid,
        force: true,
        reason: 'Administrator cancellation is required.',
        target: { planPath: fixture.planPath, planDigest: computeSha256(planContent) },
        payload: {},
      }),
    );
    const beforeStatus = runGit(fixture.root, ['status', '--short']);

    const preview = spawnSync(
      process.execPath,
      [commandPath, 'preview', '--request', requestPath, '--repo', fixture.root],
      { encoding: 'utf8' },
    );

    expect(preview.status).toBe(0);
    const transition = JSON.parse(preview.stdout);
    expect(transition.result).toEqual({ acceptanceStatus: 'not-achieved' });
    expect(transition.deletions).toEqual([fixture.planPath]);
    expect(runGit(fixture.root, ['status', '--short'])).toBe(beforeStatus);
  });

  it.each([
    ['preview', 'local'],
    ['preview', 'workflow'],
    ['apply', 'local'],
    ['apply', 'workflow'],
  ] as const)(
    'reads a remote-only supersession blob for %s through %s transport',
    (command, kind) => {
      const fixture = createRepositoryFixture();
      const successor = createGovernanceDecisionFixturePlanRecord();
      successor.planId = 'remote-successor';
      successor.capabilities[0].activation.slice = 'remote-successor-slice';
      successor.checkpoint.nextSlices = ['remote-successor-slice'];
      const successorMarkdown =
        `# Remote successor\n\n\`\`\`plan-adaptation-v1\n` +
        `${JSON.stringify(successor, null, 2)}\n\`\`\`\n`;
      const successorBlobOid = computeGitBlobOid(successorMarkdown);
      expect(
        spawnSync('git', ['cat-file', '-e', successorBlobOid], { cwd: fixture.root }).status,
      ).not.toBe(0);

      const requestRoot = mkdtempSync(path.join(tmpdir(), 'governance-command-request-'));
      fixtureRoots.push(requestRoot);
      const requestPath = path.join(requestRoot, 'supersede-request.json');
      writeFileSync(
        requestPath,
        JSON.stringify({
          schemaVersion: 'governance-decision-request-v1',
          operation: 'plan.supersede',
          repository: 'intact-software-systems/ar-eye-hunter',
          defaultBranch: 'main',
          expectedHeadOid: fixture.headOid,
          force: true,
          reason: 'Transfer the active plan to the immutable remote successor.',
          target: {
            planPath: fixture.planPath,
            planDigest: computeSha256(readFileSync(path.join(fixture.root, fixture.planPath))),
          },
          payload: {
            successorPlanPath: 'plans/remote-successor.md',
            successorPlanBlobOid: successorBlobOid,
          },
        }),
      );
      const binRoot = path.join(requestRoot, 'bin');
      mkdirSync(binRoot);
      const ghPath = path.join(binRoot, 'gh');
      writeFileSync(
        ghPath,
        fakeGitHubCli({
          headOid: fixture.headOid,
          successorBlobOid,
          successorMarkdown,
        }),
      );
      chmodSync(ghPath, 0o755);

      const preview = spawnSync(
        process.execPath,
        [commandPath, command, '--request', requestPath, '--repo', fixture.root],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binRoot}:${process.env.PATH}`,
            ...(kind === 'workflow' ? workflowEnvironment(fixture.headOid) : {}),
          },
        },
      );

      expect(preview.stderr).toBe('');
      expect(preview.status).toBe(0);
      if (command === 'preview') {
        expect(JSON.parse(preview.stdout)).toMatchObject({
          result: { acceptanceStatus: 'transferred' },
          additions: expect.arrayContaining([
            { path: 'plans/remote-successor.md', content: successorMarkdown },
          ]),
        });
      } else {
        expect(JSON.parse(preview.stdout)).toEqual({ oid: '9'.repeat(40) });
      }
    },
  );

  it('applies a gate deviation with pre-read Actions evidence and a distinct App publisher', () => {
    const fixture = createRepositoryFixture();
    const requestRoot = mkdtempSync(path.join(tmpdir(), 'governance-gate-command-'));
    fixtureRoots.push(requestRoot);
    const requestPath = path.join(requestRoot, 'gate-request.json');
    const evidencePath = path.join(requestRoot, 'gate-evidence.json');
    writeFileSync(
      requestPath,
      JSON.stringify({
        schemaVersion: 'governance-decision-request-v1',
        operation: 'gate.accept-deviation',
        repository: 'intact-software-systems/ar-eye-hunter',
        defaultBranch: 'main',
        expectedHeadOid: fixture.headOid,
        force: true,
        reason: 'Administrator accepts this exact failed gate.',
        target: {
          workflowRunId: 81,
          runAttempt: 2,
          gateName: 'Governance Gate / Governance Gate',
          candidateSha: '2'.repeat(40),
        },
        payload: {},
      }),
    );
    writeFileSync(
      evidencePath,
      JSON.stringify({
        run: {
          id: 81,
          run_attempt: 2,
          head_sha: '2'.repeat(40),
          status: 'completed',
          conclusion: 'failure',
        },
        jobs: [
          {
            id: 91,
            run_id: 81,
            run_attempt: 2,
            head_sha: '2'.repeat(40),
            name: 'Governance Gate / Governance Gate',
            status: 'completed',
            conclusion: 'failure',
          },
        ],
      }),
    );
    const binRoot = path.join(requestRoot, 'bin');
    mkdirSync(binRoot);
    const ghPath = path.join(binRoot, 'gh');
    writeFileSync(
      ghPath,
      fakeGitHubCli({
        headOid: fixture.headOid,
        successorBlobOid: '3'.repeat(40),
        successorMarkdown: 'unused',
      }),
    );
    chmodSync(ghPath, 0o755);

    const applied = spawnSync(
      process.execPath,
      [commandPath, 'apply', '--request', requestPath, '--repo', fixture.root],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binRoot}:${process.env.PATH}`,
          ...workflowEnvironment(fixture.headOid),
          GOVERNANCE_GATE_EVIDENCE_PATH: evidencePath,
        },
      },
    );

    expect(applied.stderr).toBe('');
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout)).toEqual({ oid: '9'.repeat(40) });
  });

  it('keeps permanent fixtures independent from the disposable tactical plan', () => {
    const disposablePlanPath = ['plans/authenticated', 'governance-decisions-plan.md'].join('-');
    for (const testFile of [
      'governance-decision-command.test.ts',
      'governance-decision-commit-verification.test.ts',
      'governance-decision-transitions.test.ts',
    ]) {
      expect(readFileSync(path.join(import.meta.dirname, testFile), 'utf8')).not.toContain(
        disposablePlanPath,
      );
    }
  });
});

function createRepositoryFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'governance-command-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '-q']);
  runGit(root, ['config', 'user.name', 'Fixture']);
  runGit(root, ['config', 'user.email', 'fixture@example.com']);
  mkdirSync(path.join(root, 'plans'), { recursive: true });
  const planPath = 'plans/authenticated-governance-decisions.md';
  writeFileSync(path.join(root, planPath), toGovernanceDecisionFixturePlanMarkdown());
  writeFileSync(path.join(root, 'plans/README.md'), '# Active adaptive plans\n\nBefore.\n');
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-q', '-m', 'fixture']);
  return { root, planPath, headOid: runGit(root, ['rev-parse', 'HEAD']).trim() };
}

function runGit(root: string, arguments_: string[]) {
  return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' });
}

function computeGitBlobOid(content: string) {
  const bytes = Buffer.from(content);
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function fakeGitHubCli(input: {
  headOid: string;
  successorBlobOid: string;
  successorMarkdown: string;
}) {
  const responses = {
    user: { login: 'repository-admin', type: 'User' },
    permission: { permission: 'admin', user: { login: 'repository-admin' } },
    main: { object: { sha: input.headOid } },
    blob: {
      sha: input.successorBlobOid,
      encoding: 'base64',
      content: Buffer.from(input.successorMarkdown).toString('base64'),
      size: Buffer.byteLength(input.successorMarkdown),
    },
    commit: {
      data: { createCommitOnBranch: { commit: { oid: '9'.repeat(40) } } },
    },
  };
  return `#!/usr/bin/env node
const endpoint = process.argv[3];
const responses = ${JSON.stringify(responses)};
let response;
if (endpoint === 'user') response = responses.user;
else if (endpoint.includes('/permission')) response = responses.permission;
else if (endpoint.endsWith('/git/ref/heads/main')) response = responses.main;
else if (endpoint.includes('/git/blobs/')) response = responses.blob;
else if (endpoint === 'graphql') response = responses.commit;
else throw new Error('unexpected fake GitHub endpoint: ' + endpoint);
process.stdout.write(JSON.stringify(response));
`;
}

function workflowEnvironment(headOid: string) {
  const workflowRef =
    'intact-software-systems/ar-eye-hunter/' +
    '.github/workflows/governance-decision.yml@refs/heads/main';
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'intact-software-systems/ar-eye-hunter',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: workflowRef,
    GITHUB_WORKFLOW_SHA: headOid,
    GITHUB_SHA: headOid,
    GITHUB_ACTOR: 'repository-admin',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GOVERNANCE_APP_SLUG: 'governance-decisions',
    GOVERNANCE_CONFIGURED_APP_SLUG: 'governance-decisions',
    GOVERNANCE_PREFLIGHT_ACTOR: 'repository-admin',
    GOVERNANCE_PREFLIGHT_SHA: headOid,
    GOVERNANCE_PREFLIGHT_WORKFLOW_REF: workflowRef,
  };
}

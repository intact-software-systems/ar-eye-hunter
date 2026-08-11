import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { retainedLedgerHash } from '../../../scripts/pr-human-review/trusted-retained-legacy.mjs';

const repoRoot = process.cwd();
const validatorPath = path.join(repoRoot, 'scripts/check-pr-human-review.mjs');
const fixtureRoots: string[] = [];
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('PR human review record validator', () => {
  it('runs a read-only pull-request workflow for every review-state transition', () => {
    const workflow = readFileSync(
      path.join(repoRoot, '.github/workflows/pr-human-review-record.yml'),
      'utf8',
    );

    for (const eventType of [
      'opened',
      'edited',
      'synchronize',
      'reopened',
      'converted_to_draft',
      'ready_for_review',
    ]) {
      expect(workflow).toContain(`- ${eventType}`);
    }
    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('pull-requests: read');
    expect(workflow).toContain('actions/checkout@v7');
    expect(workflow).toContain('actions/setup-node@v7');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('github.event.pull_request.base.sha');
    expect(workflow).toContain('ref: ${{ github.event.pull_request.base.sha }}');
    expect(workflow).not.toContain('ref: ${{ github.event.pull_request.head.sha }}');
    expect(workflow).toContain('CANDIDATE_HEAD_SHA');
    expect(workflow).toContain('Fetch candidate Git objects as data');
    expect(workflow).toContain('Read candidate legacy registry as data');
    expect(workflow).toContain('gh api --paginate --slurp');
    expect(workflow).toContain('--event "$GITHUB_EVENT_PATH"');

    const registryStep = workflow.slice(
      workflow.indexOf('Read candidate legacy registry as data'),
      workflow.indexOf('Read trusted GitHub review evidence'),
    );
    expect(registryStep).toContain(
      'git show "$CANDIDATE_HEAD_SHA:docs/production-legacy-exceptions.md"',
    );
    expect(registryStep).not.toContain('GH_TOKEN');
  });

  it.each(['null', 'true', 'false', '1', '"record"', '[]'])(
    'rejects a non-object metadata value: %s',
    (metadata) => {
      const fixture = createFixture({
        body: `${requiredNarrative()}\n\n\`\`\`pr-human-review-record-v1\n${metadata}\n\`\`\`\n`,
        changedPaths: ['scripts/new-check.mjs'],
      });
      const result = runValidator(fixture);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('metadata must be a plain object');
    },
  );

  it('rejects duplicate metadata fences and unbound or contradictory visible evidence', () => {
    const duplicateFence = createFixture({
      body: `${recordBody({ initialReview: review() })}${recordBody({ initialReview: review() })}`,
      changedPaths: ['scripts/new-check.mjs'],
    });
    const duplicateResult = runValidator(duplicateFence);

    expect(duplicateResult.status).toBe(1);
    expect(duplicateResult.stdout).toContain('exactly one metadata fence');

    const contradictoryVisibleEvidence = createFixture({
      body: recordBody({ initialReview: review() }).replace(
        'The command reads the PR record and reports evidence errors.',
        'TODO',
      ),
      changedPaths: ['scripts/new-check.mjs'],
    });
    const contradictoryResult = runValidator(contradictoryVisibleEvidence);

    expect(contradictoryResult.status).toBe(1);
    expect(contradictoryResult.stdout).toContain('visible narrative evidence');

    const standardNarrative = review().narrative;
    const injectedReview = review({
      narrative: {
        ...standardNarrative,
        productionOwnerToResultTrace: [
          'The command reads the PR record and reports evidence errors.',
          '<!-- pr-human-review:initial:productionOwnerToResultTrace:start -->',
          'The command reads the PR record and reports evidence errors.',
          '<!-- pr-human-review:initial:productionOwnerToResultTrace:end -->',
        ].join('\n'),
      },
    });
    const metadataOnlyMarkers = createFixture({
      body: `${requiredNarrative()}\n\n\`\`\`pr-human-review-record-v1\n${JSON.stringify(
        {
          version: 1,
          scope: 'code-changing',
          exemption: null,
          initialReview: injectedReview,
          finalReview: null,
          retainedLegacy: [],
        },
        null,
        2,
      )}\n\`\`\`\n`,
      changedPaths: ['scripts/new-check.mjs'],
    });
    const metadataOnlyResult = runValidator(metadataOnlyMarkers);

    expect(metadataOnlyResult.status).toBe(1);
    expect(metadataOnlyResult.stdout).toContain(
      'initial visible narrative evidence productionOwnerToResultTrace is required',
    );
  });

  it('rejects kind-mismatched and nested-code exemptions after path normalization', () => {
    const wrongKind = createFixture({
      body: recordBody({
        scope: 'exempt',
        exemption: { kind: 'plan-only', changedPaths: ['docs/repo-human-style-guide.md'] },
      }),
      changedPaths: ['docs/repo-human-style-guide.md'],
    });
    const wrongKindResult = runValidator(wrongKind);

    expect(wrongKindResult.status).toBe(1);
    expect(wrongKindResult.stdout).toContain('plan-only exemption path is not allowed');

    const nestedScript = createFixture({
      body: recordBody({
        scope: 'exempt',
        exemption: {
          kind: 'documentation-only',
          changedPaths: ['docs/guides/scripts/review-check.mjs'],
        },
      }),
      changedPaths: ['docs/guides/scripts/review-check.mjs'],
    });
    const nestedScriptResult = runValidator(nestedScript);

    expect(nestedScriptResult.status).toBe(1);
    expect(nestedScriptResult.stdout).toContain('documentation-only exemption path is not allowed');
  });

  it('allows an explicit plan-only exemption when every changed path is exempt', () => {
    const fixture = createFixture({
      body: recordBody({
        scope: 'exempt',
        exemption: { kind: 'plan-only', changedPaths: ['docs/superpowers/plans/example.md'] },
      }),
      changedPaths: ['docs/superpowers/plans/example.md'],
    });

    const validResult = runValidator(fixture);
    expect(validResult.status, validResult.stdout).toBe(0);
  });

  it('compares normalized exemption paths as a set instead of trusting their order', () => {
    const fixture = createFixture({
      body: recordBody({
        scope: 'exempt',
        exemption: {
          kind: 'documentation-only',
          changedPaths: ['docs/guide-a.md', 'docs/guide-b.md'],
        },
      }),
      changedPaths: ['docs/guide-a.md', 'docs/guide-b.md'],
    });
    writeFixture(fixture, 'changed-paths.txt', 'docs/guide-b.md\n./docs//guide-a.md\n');

    const result = runValidator(fixture);

    expect(result.status, result.stdout).toBe(0);
  });

  it.each([
    'packages/tests/repo/test.ts',
    'scripts/check-pr-human-review.mjs',
    '.github/workflows/pr-human-review-record.yml',
    'package.json',
    'apps/api-v1/src/server.ts',
  ])('rejects a documentation exemption when code-adjacent path changed: %s', (changedPath) => {
    const fixture = createFixture({
      body: recordBody({
        scope: 'exempt',
        exemption: { kind: 'documentation-only', changedPaths: [changedPath] },
      }),
      changedPaths: [changedPath],
    });

    const result = runValidator(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('exemption path is not allowed');
  });

  it('rejects a missing review record for a code-changing draft', () => {
    const fixture = createFixture({ body: '', changedPaths: ['scripts/new-check.mjs'] });
    const result = runValidator(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'PR Human Review Record v1 must contain exactly one metadata fence',
    );
  });

  it('rejects malformed record metadata and placeholder evidence', () => {
    const malformed = createFixture({
      body: `${requiredNarrative()}\n\n\`\`\`pr-human-review-record-v1\n{ bad json }\n\`\`\`\n`,
      changedPaths: ['scripts/new-check.mjs'],
    });
    const malformedResult = runValidator(malformed);

    expect(malformedResult.status).toBe(1);
    expect(malformedResult.stdout).toContain('metadata block is not valid JSON');

    const placeholder = createFixture({
      body: recordBody({
        initialReview: review({
          narrative: { ...review().narrative, productionOwnerToResultTrace: 'TODO' },
        }),
      }),
      changedPaths: ['scripts/new-check.mjs'],
    });
    const placeholderResult = runValidator(placeholder);

    expect(placeholderResult.status).toBe(1);
    expect(placeholderResult.stdout).toContain('placeholder evidence');
  });

  it('requires a fresh initial review for a code-changing draft', () => {
    const fixture = createFixture({
      body: recordBody({ initialReview: review({ headSha: 'c'.repeat(40) }) }),
      changedPaths: ['scripts/new-check.mjs'],
    });
    const result = runValidator(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('initial review head SHA must match current head');
  });

  it('uses the actual Git merge base instead of a diverged pull-request base tip', () => {
    const fixture = createFixture({ body: '', changedPaths: [] });
    const mergeBaseSha = createGitCommit(fixture, 'base', { 'README.md': 'base\n' });
    const baseTipSha = createGitCommit(fixture, 'base tip', { 'docs/base.md': 'base tip\n' });
    runGit(fixture, ['checkout', '-b', 'candidate', mergeBaseSha]);
    const candidateHeadSha = createGitCommit(fixture, 'candidate', {
      'scripts/candidate.mjs': 'export {};\n',
    });
    writeFixture(
      fixture,
      'body.md',
      recordBody({ initialReview: review({ mergeBaseSha, headSha: candidateHeadSha }) }),
    );
    writeFixture(
      fixture,
      'event.json',
      JSON.stringify({
        pull_request: {
          body: readFixture(fixture, 'body.md'),
          draft: true,
          base: { sha: baseTipSha },
          head: { sha: candidateHeadSha },
        },
      }),
    );
    const result = runEventValidator(fixture);

    expect(result.status, result.stdout).toBe(0);
  });

  it('allows a complete draft initial review with no final review yet', () => {
    const fixture = createFixture({
      body: recordBody({ initialReview: review() }),
      changedPaths: ['scripts/new-check.mjs'],
    });

    const validRetainedResult = runValidator(fixture);
    expect(validRetainedResult.status, validRetainedResult.stdout).toBe(0);
  });

  it('requires a fresh final code and legacy review when the pull request is ready', () => {
    const fixture = createFixture({
      draft: false,
      body: recordBody({
        initialReview: review({ headSha: 'd'.repeat(40) }),
        finalReview: review({ stage: 'final', headSha }),
      }),
      changedPaths: ['scripts/new-check.mjs'],
    });

    expect(runValidator(fixture).status).toBe(0);

    const staleFixture = createFixture({
      draft: false,
      body: recordBody({
        initialReview: review(),
        finalReview: review({ stage: 'final', headSha: 'e'.repeat(40) }),
      }),
      changedPaths: ['scripts/new-check.mjs'],
    });
    const staleResult = runValidator(staleFixture);

    expect(staleResult.status).toBe(1);
    expect(staleResult.stdout).toContain('final review head SHA must match current head');
  });

  it('requires initial reviewer metadata even after the pull request is ready', () => {
    const fixture = createFixture({
      draft: false,
      body: recordBody({ finalReview: review({ stage: 'final' }) }),
      changedPaths: ['scripts/new-check.mjs'],
    });
    const result = runValidator(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('initial review metadata is required');
  });

  it('rejects unresolved Critical or Important final findings', () => {
    const fixture = createFixture({
      draft: false,
      body: recordBody({
        initialReview: review(),
        finalReview: review({
          stage: 'final',
          unresolvedFindings: { critical: 1, important: 0 },
        }),
      }),
      changedPaths: ['scripts/new-check.mjs'],
    });
    const result = runValidator(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('final review has unresolved Critical findings');
  });

  it('requires complete ledger, registry, and human approval evidence for retained legacy', () => {
    const retainedItem = {
      id: 'production-legacy-example',
      path: 'apps/example/compat.ts',
      symbol: 'compatibilityEntry',
      disposition: 'retained-pending-human-approval',
    };
    const approval = retainedApproval({ id: retainedItem.id });
    approval.ledgerSha256 = retainedLedgerHash({ item: retainedItem, approval });
    const record = {
      initialReview: review({ legacy: { candidateCount: 1, items: [retainedItem] } }),
      finalReview: review({ stage: 'final', legacy: { candidateCount: 1, items: [retainedItem] } }),
      retainedLegacy: [approval],
    };
    const fixture = createFixture({
      draft: false,
      body: recordBody(record),
      changedPaths: ['scripts/new-check.mjs'],
      registry: registryEntry(approval),
      reviews: [[trustedReview(retainedItem, approval)]],
    });

    const validRetainedResult = runValidator(fixture);
    expect(validRetainedResult.status, validRetainedResult.stdout).toBe(0);

    const noApproval = createFixture({
      draft: false,
      body: recordBody({ ...record, retainedLegacy: [] }),
      changedPaths: ['scripts/new-check.mjs'],
      registry: registryEntry(approval),
    });
    const noApprovalResult = runValidator(noApproval);

    expect(noApprovalResult.status).toBe(1);
    expect(noApprovalResult.stdout).toContain('retained legacy is missing trusted human approval');

    const olderApproval = retainedApproval({
      id: retainedItem.id,
      approvedProductionSha: 'f'.repeat(40),
    });
    olderApproval.ledgerSha256 = retainedLedgerHash({
      item: retainedItem,
      approval: olderApproval,
    });
    const olderApprovalFixture = createFixture({
      draft: false,
      body: recordBody({
        ...record,
        retainedLegacy: [olderApproval],
      }),
      changedPaths: ['scripts/new-check.mjs'],
      registry: registryEntry(olderApproval),
      reviews: [trustedReview(retainedItem, olderApproval)],
      pathsAfterApproval: {
        [olderApproval.approvedProductionSha]: ['apps/example/new-production.ts'],
      },
    });
    const olderApprovalResult = runValidator(olderApprovalFixture);

    expect(olderApprovalResult.status).toBe(1);
    expect(olderApprovalResult.stdout).toContain(
      'production change invalidates retained legacy approval',
    );
  });

  it('rejects a bot review even when candidate metadata claims human approval', () => {
    const retainedItem = {
      id: 'production-legacy-example',
      path: 'apps/example/compat.ts',
      symbol: 'compatibilityEntry',
      disposition: 'retained-pending-human-approval',
    };
    const approval = retainedApproval({ id: retainedItem.id });
    approval.ledgerSha256 = retainedLedgerHash({ item: retainedItem, approval });
    const fixture = createFixture({
      draft: false,
      body: recordBody({
        initialReview: review({ legacy: { candidateCount: 1, items: [retainedItem] } }),
        finalReview: review({
          stage: 'final',
          legacy: { candidateCount: 1, items: [retainedItem] },
        }),
        retainedLegacy: [approval],
      }),
      changedPaths: ['scripts/new-check.mjs'],
      registry: registryEntry(approval),
      reviews: [
        {
          ...trustedReview(retainedItem, approval),
          user: { type: 'Bot', login: approval.reviewerLogin },
        },
      ],
    });
    const result = runValidator(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('trusted GitHub review is not an approved human reviewer');
  });

  it('allows only a registry-evidence commit after an approved production candidate', () => {
    const fixture = createFixture({ body: '', changedPaths: [] });
    const mergeBaseSha = createGitCommit(fixture, 'base', { 'README.md': 'base\n' });
    const approvedProductionSha = createGitCommit(fixture, 'production candidate', {
      'apps/example/compat.ts': 'export const compatibilityEntry = true;\n',
    });
    const retainedItem = {
      id: 'production-legacy-example',
      path: 'apps/example/compat.ts',
      symbol: 'compatibilityEntry',
      disposition: 'retained-pending-human-approval',
    };
    const approval = retainedApproval({ id: retainedItem.id, approvedProductionSha });
    approval.ledgerSha256 = retainedLedgerHash({ item: retainedItem, approval });
    const candidateHeadSha = createGitCommit(fixture, 'record approved legacy', {
      'docs/production-legacy-exceptions.md': registryEntry(approval),
    });
    const body = recordBody({
      initialReview: review({
        mergeBaseSha,
        headSha: candidateHeadSha,
        legacy: { candidateCount: 1, items: [retainedItem] },
      }),
      finalReview: review({
        stage: 'final',
        mergeBaseSha,
        headSha: candidateHeadSha,
        legacy: { candidateCount: 1, items: [retainedItem] },
      }),
      retainedLegacy: [approval],
    });
    writeFixture(fixture, 'body.md', body);
    writeFixture(fixture, 'registry.md', registryEntry(approval));
    writeFixture(fixture, 'reviews.json', JSON.stringify([trustedReview(retainedItem, approval)]));
    writeFixture(
      fixture,
      'event.json',
      JSON.stringify({
        pull_request: {
          body,
          draft: false,
          base: { sha: mergeBaseSha },
          head: { sha: candidateHeadSha },
        },
      }),
    );

    const result = runEventValidator(fixture);

    expect(result.status, result.stdout).toBe(0);
  });
});

interface CreateFixtureInput {
  readonly body: string;
  readonly changedPaths: readonly string[];
  readonly draft?: boolean;
  readonly registry?: string;
  readonly reviews?: readonly (Record<string, unknown> | readonly Record<string, unknown>[])[];
  readonly pathsAfterApproval?: Readonly<Record<string, readonly string[]>>;
}

function createFixture(input: CreateFixtureInput): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'pr-human-review-fixture-'));
  fixtureRoots.push(fixtureRoot);
  writeFixture(fixtureRoot, 'body.md', input.body);
  writeFixture(fixtureRoot, 'changed-paths.txt', `${input.changedPaths.join('\n')}\n`);
  writeFixture(
    fixtureRoot,
    'registry.md',
    input.registry ??
      '# Production Legacy Exception Registry\n\nNo approved retained production legacy is recorded yet.\n',
  );
  writeFixture(
    fixtureRoot,
    'input.json',
    JSON.stringify({ mergeBaseSha: baseSha, headSha, draft: input.draft ?? true }),
  );
  writeFixture(fixtureRoot, 'reviews.json', JSON.stringify(input.reviews ?? []));
  writeFixture(
    fixtureRoot,
    'paths-after-approval.json',
    JSON.stringify(input.pathsAfterApproval ?? {}),
  );
  return fixtureRoot;
}

function runValidator(fixtureRoot: string) {
  const input = JSON.parse(readFixture(fixtureRoot, 'input.json')) as {
    readonly mergeBaseSha: string;
    readonly headSha: string;
    readonly draft: boolean;
  };
  return spawnSync(
    process.execPath,
    [
      validatorPath,
      '--body',
      'body.md',
      '--changed-paths',
      'changed-paths.txt',
      '--registry',
      'registry.md',
      '--reviews',
      'reviews.json',
      '--paths-after-approval',
      'paths-after-approval.json',
      '--merge-base',
      input.mergeBaseSha,
      '--head',
      input.headSha,
      '--draft',
      String(input.draft),
    ],
    { cwd: fixtureRoot, encoding: 'utf8' },
  );
}

function runEventValidator(fixtureRoot: string) {
  return spawnSync(
    process.execPath,
    [
      validatorPath,
      '--event',
      'event.json',
      '--registry',
      'registry.md',
      '--reviews',
      'reviews.json',
    ],
    { cwd: fixtureRoot, encoding: 'utf8' },
  );
}

function createGitCommit(
  fixtureRoot: string,
  message: string,
  files: Readonly<Record<string, string>>,
): string {
  if (!readFixtureOrUndefined(fixtureRoot, '.git/HEAD')) {
    runGit(fixtureRoot, ['init', '--initial-branch=main']);
    runGit(fixtureRoot, ['config', 'user.name', 'PR Human Review Test']);
    runGit(fixtureRoot, ['config', 'user.email', 'pr-human-review@example.invalid']);
  }
  for (const [relativePath, source] of Object.entries(files)) {
    writeFixture(fixtureRoot, relativePath, source);
  }
  runGit(fixtureRoot, ['add', '.']);
  runGit(fixtureRoot, ['commit', '-m', message]);
  return runGit(fixtureRoot, ['rev-parse', 'HEAD']).trim();
}

function runGit(fixtureRoot: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function readFixture(fixtureRoot: string, relativePath: string): string {
  return readFileSync(path.join(fixtureRoot, relativePath), 'utf8');
}

function readFixtureOrUndefined(fixtureRoot: string, relativePath: string): string | undefined {
  try {
    return readFixture(fixtureRoot, relativePath);
  } catch {
    return undefined;
  }
}

function writeFixture(fixtureRoot: string, relativePath: string, source: string): void {
  const filePath = path.join(fixtureRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source);
}

interface Review {
  readonly reviewer: string;
  readonly independence: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly verdict: string;
  readonly unresolvedFindings: { readonly critical: number; readonly important: number };
  readonly narrative: {
    readonly productionOwnerToResultTrace: string;
    readonly cognitiveIndirectionFindings: string;
    readonly testsRewrittenOrRemoved: string;
    readonly productionNotCompromisedForTests: string;
    readonly automationGaps: string;
    readonly completeFindings: string;
  };
  readonly legacy: {
    readonly candidateCount: number;
    readonly items: readonly Record<string, string>[];
  };
}

function review(input: Partial<Review> & { readonly stage?: 'initial' | 'final' } = {}): Review {
  return {
    reviewer: 'Independent reviewer',
    independence: 'separate-agent-or-human',
    mergeBaseSha: baseSha,
    headSha,
    verdict: 'pass',
    unresolvedFindings: { critical: 0, important: 0 },
    narrative: {
      productionOwnerToResultTrace: 'The command reads the PR record and reports evidence errors.',
      cognitiveIndirectionFindings: 'No avoidable production control-flow was added.',
      testsRewrittenOrRemoved: 'No production tests were rewritten or removed.',
      productionNotCompromisedForTests: 'Production runtime code was unchanged.',
      automationGaps: 'The validator cannot approve semantic quality.',
      completeFindings: 'No Critical or Important findings remain.',
    },
    legacy: { candidateCount: 0, items: [] },
    ...input,
  };
}

function retainedApproval(input: { readonly id: string; readonly approvedProductionSha?: string }) {
  return {
    id: input.id,
    path: 'apps/example/compat.ts',
    symbol: 'compatibilityEntry',
    purpose: 'Retain a documented compatibility entry.',
    consumerDependency: 'Existing documented client.',
    unsafeRemovalReason: 'The client migration is not complete.',
    minimization: 'Delegates directly to the canonical entry.',
    canonicalOwner: 'apps/example/canonical.ts',
    compatibilityTests: 'packages/tests/example/compatibility.test.ts',
    owner: 'Example team',
    removalCondition: 'Remove after the documented client migrates.',
    approvedProductionSha: input.approvedProductionSha ?? headSha,
    reviewId: 1,
    reviewerLogin: 'named-human-reviewer',
    approvalDate: '2026-08-11T00:00:00Z',
    ledgerSha256: '',
  };
}

function trustedReview(
  item: { readonly id: string },
  approval: ReturnType<typeof retainedApproval>,
): Record<string, unknown> {
  return {
    id: approval.reviewId,
    state: 'APPROVED',
    commit_id: approval.approvedProductionSha,
    submitted_at: approval.approvalDate,
    user: { type: 'User', login: approval.reviewerLogin },
    body: [
      'PR-HUMAN-REVIEW-LEGACY-APPROVAL v1',
      `production-sha: ${approval.approvedProductionSha}`,
      `ledger-sha256: ${approval.ledgerSha256}`,
      `legacy-ids: ${item.id}`,
    ].join('\n'),
  };
}

function registryEntry(input: ReturnType<typeof retainedApproval>): string {
  return [
    '# Production Legacy Exception Registry',
    '',
    `### ${input.id}`,
    '',
    '- Repository-relative path and symbol: apps/example/compat.ts#compatibilityEntry',
    '- Purpose: Retain a documented compatibility entry.',
    '- Canonical implementation owner: apps/example/canonical.ts',
    '- Consumer or operational dependency: Existing documented client.',
    '- Why removal is unsafe now: The client migration is not complete.',
    '- Minimization already performed: Delegates directly to the canonical entry.',
    '- Approval date and human reviewer: 2026-08-11T00:00:00Z — named-human-reviewer',
    `- Approved production candidate SHA: ${input.approvedProductionSha}`,
    '- Compatibility tests: packages/tests/example/compatibility.test.ts',
    '- Named owner: Example team',
    '- Review or removal condition: Remove after the documented client migrates.',
    '',
  ].join('\n');
}

interface RecordInput {
  readonly scope?: 'code-changing' | 'exempt';
  readonly exemption?: { readonly kind: string; readonly changedPaths: readonly string[] };
  readonly initialReview?: Review;
  readonly finalReview?: Review;
  readonly retainedLegacy?: readonly ReturnType<typeof retainedApproval>[];
}

function recordBody(input: RecordInput = {}): string {
  const record = {
    version: 1,
    scope: input.scope ?? 'code-changing',
    exemption: input.exemption ?? null,
    initialReview: input.initialReview ?? null,
    finalReview: input.finalReview ?? null,
    retainedLegacy: input.retainedLegacy ?? [],
  };
  return `${requiredNarrative(record)}\n\n\`\`\`pr-human-review-record-v1\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;
}

function requiredNarrative(record?: {
  readonly initialReview?: Review | null;
  readonly finalReview?: Review | null;
}): string {
  const labels = [
    '## PR Human Review Record v1',
    '### PR classification',
    '### Initial independent review',
    'Production owner-to-result trace:',
    'Cognitive-indirection findings:',
    'Complete review findings and resolution/status:',
    'Tests rewritten or removed:',
    'Production was not compromised for tests:',
    'Behavior and judgment not proven by automation:',
    'Legacy candidate count:',
    'Legacy ledger and dispositions:',
    '### Complete code and legacy review',
  ];
  return [
    ...labels,
    ...visibleNarrative('initial', record?.initialReview?.narrative),
    ...visibleNarrative('final', record?.finalReview?.narrative),
  ].join('\n');
}

function visibleNarrative(
  stage: 'initial' | 'final',
  narrative: Review['narrative'] | undefined,
): string[] {
  if (!narrative) {
    return [];
  }
  return Object.entries(narrative).flatMap(([key, value]) => [
    `<!-- pr-human-review:${stage}:${key}:start -->`,
    value,
    `<!-- pr-human-review:${stage}:${key}:end -->`,
  ]);
}

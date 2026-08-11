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
    expect(contradictoryResult.stdout).toContain('visible review');

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
      'initial visible review productionOwnerToResultTrace is required',
    );
  });

  it('binds the visible final legacy count and rejects duplicated ordered review sections', () => {
    const finalReview = review({
      stage: 'final',
      legacy: { candidateCount: 1, items: [retainedItemExample()] },
    });
    const mismatchedCount = createFixture({
      draft: false,
      body: recordBody({ initialReview: review(), finalReview }).replace(
        '- Legacy candidate count: 1',
        '- Legacy candidate count: 2',
      ),
      changedPaths: ['scripts/new-check.mjs'],
    });
    const mismatchResult = runValidator(mismatchedCount);

    expect(mismatchResult.status).toBe(1);
    expect(mismatchResult.stdout).toContain('legacyCandidateCount');

    const duplicatedSection = createFixture({
      body: `${recordBody({ initialReview: review() })}\n### Initial independent review`,
      changedPaths: ['scripts/new-check.mjs'],
    });
    const duplicateResult = runValidator(duplicatedSection);

    expect(duplicateResult.status).toBe(1);
    expect(duplicateResult.stdout).toContain('exactly one ### Initial independent review section');
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
      approvalHistory: {
        [olderApproval.approvedProductionSha]: {
          isAncestor: true,
          changedPaths: ['apps/example/new-production.ts'],
        },
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

  it('requires every retained approval to bind the same complete sorted ledger', () => {
    const firstItem = retainedItemExample();
    const secondItem = {
      id: 'production-legacy-second',
      path: 'apps/example/second-compat.ts',
      symbol: 'secondCompatibilityEntry',
      disposition: 'retained-pending-human-approval',
    };
    const items = [secondItem, firstItem];
    const firstApproval = retainedApproval({ id: firstItem.id });
    const secondApproval = {
      ...retainedApproval({ id: secondItem.id }),
      path: secondItem.path,
      symbol: secondItem.symbol,
    };
    const ledgerHash = retainedLedgerHash({ items });
    firstApproval.ledgerSha256 = ledgerHash;
    secondApproval.ledgerSha256 = ledgerHash;
    const body = recordBody({
      initialReview: review({ legacy: { candidateCount: 2, items } }),
      finalReview: review({ stage: 'final', legacy: { candidateCount: 2, items } }),
      retainedLegacy: [firstApproval, secondApproval],
    });
    const fixture = createFixture({
      draft: false,
      body,
      changedPaths: ['scripts/new-check.mjs'],
      registry: `${registryEntry(firstApproval)}\n${registryEntry(secondApproval)}`,
      reviews: [trustedReview(items, firstApproval)],
    });

    const validResult = runValidator(fixture);
    expect(validResult.status, validResult.stdout).toBe(0);

    const fragmented = createFixture({
      draft: false,
      body: recordBody({
        initialReview: review({ legacy: { candidateCount: 2, items } }),
        finalReview: review({ stage: 'final', legacy: { candidateCount: 2, items } }),
        retainedLegacy: [
          firstApproval,
          { ...secondApproval, ledgerSha256: retainedLedgerHash({ items: [secondItem] }) },
        ],
      }),
      changedPaths: ['scripts/new-check.mjs'],
      registry: `${registryEntry(firstApproval)}\n${registryEntry(secondApproval)}`,
      reviews: [trustedReview(items, firstApproval)],
    });

    const fragmentedResult = runValidator(fragmented);
    expect(fragmentedResult.status).toBe(1);
    expect(fragmentedResult.stdout).toContain('ledger hash does not match the final ledger');
  });

  it.each([
    {
      name: 'an unauthorized repository association',
      review: { author_association: 'CONTRIBUTOR' },
      prAuthorLogin: 'pull-request-author',
      expected: 'repository-authorized reviewer',
    },
    {
      name: 'the pull request author',
      review: {},
      prAuthorLogin: 'named-human-reviewer',
      expected: 'must not be the pull request author',
    },
  ])(
    'rejects $name as retained legacy approver',
    ({ review: reviewPatch, prAuthorLogin, expected }) => {
      const retainedItem = retainedItemExample();
      const approval = approvalForItems([retainedItem]);
      const fixture = retainedFixture({
        approval,
        items: [retainedItem],
        reviews: [{ ...trustedReview([retainedItem], approval), ...reviewPatch }],
        prAuthorLogin,
      });

      const result = runValidator(fixture);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(expected);
    },
  );

  it.each([
    { state: 'CHANGES_REQUESTED', label: 'later changes request' },
    { state: 'DISMISSED', label: 'later dismissal' },
    { state: 'APPROVED', label: 'later superseding approval' },
  ])('rejects an approved review superseded by $label', ({ state }) => {
    const retainedItem = retainedItemExample();
    const approval = approvalForItems([retainedItem]);
    const fixture = retainedFixture({
      approval,
      items: [retainedItem],
      reviews: [
        trustedReview([retainedItem], approval),
        {
          ...trustedReview([retainedItem], approval),
          id: 2,
          state,
          submitted_at: '2026-08-11T00:01:00Z',
        },
      ],
    });

    const result = runValidator(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('latest effective substantive review');
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
          user: { login: 'pull-request-author' },
          base: { sha: mergeBaseSha },
          head: { sha: candidateHeadSha },
        },
      }),
    );

    const result = runEventValidator(fixture);

    expect(result.status, result.stdout).toBe(0);
  });

  it('rejects a divergent post-approval history even when its diff lists only registry evidence', () => {
    const retainedItem = retainedItemExample();
    const approval = retainedApproval({
      id: retainedItem.id,
      approvedProductionSha: 'f'.repeat(40),
    });
    approval.ledgerSha256 = retainedLedgerHash({ items: [retainedItem] });
    const fixture = retainedFixture({
      approval,
      items: [retainedItem],
      reviews: [trustedReview([retainedItem], approval)],
    });
    writeFixture(
      fixture,
      'approval-history.json',
      JSON.stringify({
        [approval.approvedProductionSha]: {
          isAncestor: false,
          changedPaths: ['docs/production-legacy-exceptions.md'],
        },
      }),
    );

    const result = runValidator(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('post-approval path evidence is missing');
  });
});

interface CreateFixtureInput {
  readonly body: string;
  readonly changedPaths: readonly string[];
  readonly draft?: boolean;
  readonly registry?: string;
  readonly reviews?: readonly (Record<string, unknown> | readonly Record<string, unknown>[])[];
  readonly approvalHistory?: Readonly<
    Record<string, { readonly isAncestor: boolean; readonly changedPaths: readonly string[] }>
  >;
  readonly prAuthorLogin?: string;
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
    JSON.stringify({
      mergeBaseSha: baseSha,
      headSha,
      draft: input.draft ?? true,
      prAuthorLogin: input.prAuthorLogin ?? 'pull-request-author',
    }),
  );
  writeFixture(fixtureRoot, 'reviews.json', JSON.stringify(input.reviews ?? []));
  writeFixture(fixtureRoot, 'approval-history.json', JSON.stringify(input.approvalHistory ?? {}));
  return fixtureRoot;
}

function runValidator(fixtureRoot: string) {
  const input = JSON.parse(readFixture(fixtureRoot, 'input.json')) as {
    readonly mergeBaseSha: string;
    readonly headSha: string;
    readonly draft: boolean;
    readonly prAuthorLogin: string;
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
      '--approval-history',
      'approval-history.json',
      '--merge-base',
      input.mergeBaseSha,
      '--head',
      input.headSha,
      '--draft',
      String(input.draft),
      '--pr-author',
      input.prAuthorLogin,
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
  item: { readonly id: string } | readonly { readonly id: string }[],
  approval: ReturnType<typeof retainedApproval>,
): Record<string, unknown> {
  return {
    id: approval.reviewId,
    state: 'APPROVED',
    commit_id: approval.approvedProductionSha,
    submitted_at: approval.approvalDate,
    user: { type: 'User', login: approval.reviewerLogin },
    author_association: 'MEMBER',
    body: [
      'PR-HUMAN-REVIEW-LEGACY-APPROVAL v1',
      `production-sha: ${approval.approvedProductionSha}`,
      `ledger-sha256: ${approval.ledgerSha256}`,
      `legacy-ids: ${(Array.isArray(item) ? item : [item])
        .map((ledgerItem) => ledgerItem.id)
        .sort()
        .join(',')}`,
    ].join('\n'),
  };
}

function retainedItemExample() {
  return {
    id: 'production-legacy-example',
    path: 'apps/example/compat.ts',
    symbol: 'compatibilityEntry',
    disposition: 'retained-pending-human-approval',
  };
}

function approvalForItems(items: readonly ReturnType<typeof retainedItemExample>[]) {
  const approval = retainedApproval({ id: items[0].id });
  approval.ledgerSha256 = retainedLedgerHash({ item: items[0], approval });
  return approval;
}

function retainedFixture(input: {
  readonly approval: ReturnType<typeof approvalForItems>;
  readonly items: readonly ReturnType<typeof retainedItemExample>[];
  readonly reviews: readonly Record<string, unknown>[];
  readonly prAuthorLogin?: string;
}): string {
  return createFixture({
    draft: false,
    body: recordBody({
      initialReview: review({ legacy: { candidateCount: input.items.length, items: input.items } }),
      finalReview: review({
        stage: 'final',
        legacy: { candidateCount: input.items.length, items: input.items },
      }),
      retainedLegacy: [input.approval],
    }),
    changedPaths: ['scripts/new-check.mjs'],
    registry: registryEntry(input.approval),
    reviews: input.reviews,
    prAuthorLogin: input.prAuthorLogin,
  });
}

function registryEntry(input: ReturnType<typeof retainedApproval>): string {
  return [
    '# Production Legacy Exception Registry',
    '',
    `### ${input.id}`,
    '',
    `- Repository-relative path and symbol: ${input.path}#${input.symbol}`,
    `- Purpose: ${input.purpose}`,
    `- Canonical implementation owner: ${input.canonicalOwner}`,
    `- Consumer or operational dependency: ${input.consumerDependency}`,
    `- Why removal is unsafe now: ${input.unsafeRemovalReason}`,
    `- Minimization already performed: ${input.minimization}`,
    `- Approval date and human reviewer: ${input.approvalDate} — ${input.reviewerLogin}`,
    `- Approved production candidate SHA: ${input.approvedProductionSha}`,
    `- Compatibility tests: ${input.compatibilityTests}`,
    `- Named owner: ${input.owner}`,
    `- Review or removal condition: ${input.removalCondition}`,
    `- GitHub PR review ID: ${input.reviewId}`,
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
  return [
    '## PR Human Review Record v1',
    '### PR classification',
    '### Initial independent review',
    ...visibleReview(record?.initialReview, 'initial'),
    '### Milestone review',
    '- No new ownership, control-flow, or legacy family appeared.',
    '### Complete code and legacy review',
    ...visibleReview(record?.finalReview, 'final'),
  ].join('\n');
}

function visibleReview(review: Review | null | undefined, stage: 'initial' | 'final'): string[] {
  if (!review) {
    return [];
  }
  const ownerTraceLabel =
    stage === 'initial'
      ? 'Production owner-to-result trace'
      : 'Changed production owner-to-result trace, including decisions, effects, failures, callbacks, compatibility branches, and tests';
  const cognitiveLabel =
    stage === 'initial'
      ? 'Cognitive-indirection findings'
      : 'Cognitive-indirection findings and resolution';
  const testsLabel =
    stage === 'initial'
      ? 'Tests rewritten or removed'
      : 'Tests rewritten or removed, with independent behavior retained';
  return [
    `- Reviewer and independence (separate agent or human): ${review.reviewer} — ${review.independence}`,
    `- Exact merge base SHA: ${review.mergeBaseSha}`,
    `- Exact candidate head SHA: ${review.headSha}`,
    `- ${ownerTraceLabel}: ${review.narrative.productionOwnerToResultTrace}`,
    `- ${cognitiveLabel}: ${review.narrative.cognitiveIndirectionFindings}`,
    `- Complete review findings and resolution/status (correctness, safety, contracts, and other human-review findings): ${review.narrative.completeFindings}`,
    `- ${testsLabel}: ${review.narrative.testsRewrittenOrRemoved}`,
    `- Production was not compromised for tests: ${review.narrative.productionNotCompromisedForTests}`,
    `- Behavior and judgment not proven by automation: ${review.narrative.automationGaps}`,
    `- Legacy candidate count: ${review.legacy.candidateCount}`,
    `- Critical findings unresolved: ${review.unresolvedFindings.critical}`,
    `- Important findings unresolved: ${review.unresolvedFindings.important}`,
    `- Verdict: ${review.verdict}`,
  ];
}

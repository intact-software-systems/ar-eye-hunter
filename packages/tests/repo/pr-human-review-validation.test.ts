import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

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
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('actions/checkout@v7');
    expect(workflow).toContain('actions/setup-node@v7');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('--event "$GITHUB_EVENT_PATH"');
  });

  it('allows an explicit plan-only exemption when every changed path is exempt', () => {
    const fixture = createFixture({
      body: recordBody({
        scope: 'exempt',
        exemption: { kind: 'plan-only', changedPaths: ['docs/superpowers/plans/example.md'] },
      }),
      changedPaths: ['docs/superpowers/plans/example.md'],
    });

    expect(runValidator(fixture).status).toBe(0);
  });

  it('rejects an exemption when a test, script, workflow, or package file changed', () => {
    const fixture = createFixture({
      body: recordBody({
        scope: 'exempt',
        exemption: { kind: 'documentation-only', changedPaths: ['packages/tests/repo/test.ts'] },
      }),
      changedPaths: ['packages/tests/repo/test.ts'],
    });

    const result = runValidator(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('exemption path is not allowed');
  });

  it('rejects a missing review record for a code-changing draft', () => {
    const fixture = createFixture({ body: '', changedPaths: ['scripts/new-check.mjs'] });
    const result = runValidator(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('PR Human Review Record v1 metadata block is missing');
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

  it('allows a complete draft initial review with no final review yet', () => {
    const fixture = createFixture({
      body: recordBody({ initialReview: review() }),
      changedPaths: ['scripts/new-check.mjs'],
    });

    expect(runValidator(fixture).status).toBe(0);
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
    const record = {
      initialReview: review({ legacy: { candidateCount: 1, items: [retainedItem] } }),
      finalReview: review({ stage: 'final', legacy: { candidateCount: 1, items: [retainedItem] } }),
      retainedLegacy: [retainedApproval({ id: retainedItem.id })],
    };
    const fixture = createFixture({
      draft: false,
      body: recordBody(record),
      changedPaths: ['scripts/new-check.mjs'],
      registry: registryEntry({ id: retainedItem.id }),
    });

    expect(runValidator(fixture).status).toBe(0);

    const noApproval = createFixture({
      draft: false,
      body: recordBody({ ...record, retainedLegacy: [] }),
      changedPaths: ['scripts/new-check.mjs'],
      registry: registryEntry({ id: retainedItem.id }),
    });
    const noApprovalResult = runValidator(noApproval);

    expect(noApprovalResult.status).toBe(1);
    expect(noApprovalResult.stdout).toContain('retained legacy is missing human approval evidence');

    const olderApproval = createFixture({
      draft: false,
      body: recordBody({
        ...record,
        retainedLegacy: [retainedApproval({ id: retainedItem.id, approvedHeadSha: 'f'.repeat(40) })],
      }),
      changedPaths: ['scripts/new-check.mjs'],
      registry: registryEntry({ id: retainedItem.id, approvedHeadSha: 'f'.repeat(40) }),
    });
    const olderApprovalResult = runValidator(olderApproval);

    expect(olderApprovalResult.status).toBe(1);
    expect(olderApprovalResult.stdout).toContain('retained legacy approval must match current head');
  });
});

interface CreateFixtureInput {
  readonly body: string;
  readonly changedPaths: readonly string[];
  readonly draft?: boolean;
  readonly registry?: string;
}

function createFixture(input: CreateFixtureInput): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'pr-human-review-fixture-'));
  fixtureRoots.push(fixtureRoot);
  writeFixture(fixtureRoot, 'body.md', input.body);
  writeFixture(fixtureRoot, 'changed-paths.txt', `${input.changedPaths.join('\n')}\n`);
  writeFixture(
    fixtureRoot,
    'registry.md',
    input.registry ?? '# Production Legacy Exception Registry\n\nNo approved retained production legacy is recorded yet.\n',
  );
  writeFixture(
    fixtureRoot,
    'input.json',
    JSON.stringify({ baseSha, headSha, draft: input.draft ?? true }),
  );
  return fixtureRoot;
}

function runValidator(fixtureRoot: string) {
  const input = JSON.parse(readFixture(fixtureRoot, 'input.json')) as {
    readonly baseSha: string;
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
      '--base',
      input.baseSha,
      '--head',
      input.headSha,
      '--draft',
      String(input.draft),
    ],
    { cwd: fixtureRoot, encoding: 'utf8' },
  );
}

function readFixture(fixtureRoot: string, relativePath: string): string {
  return readFileSync(path.join(fixtureRoot, relativePath), 'utf8');
}

function writeFixture(fixtureRoot: string, relativePath: string, source: string): void {
  const filePath = path.join(fixtureRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source);
}

interface Review {
  readonly reviewer: string;
  readonly independence: string;
  readonly baseSha: string;
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
    baseSha,
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

function retainedApproval(input: { readonly id: string; readonly approvedHeadSha?: string }) {
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
    approvedHeadSha: input.approvedHeadSha ?? headSha,
    humanApprover: 'Named human reviewer',
    approvalDate: '2026-08-11',
  };
}

function registryEntry(input: { readonly id: string; readonly approvedHeadSha?: string }): string {
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
    '- Approval date and human reviewer: 2026-08-11 — Named human reviewer',
    `- Approved candidate head SHA: ${input.approvedHeadSha ?? headSha}`,
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
  return `${requiredNarrative()}\n\n\`\`\`pr-human-review-record-v1\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;
}

function requiredNarrative(): string {
  return [
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
  ].join('\n');
}

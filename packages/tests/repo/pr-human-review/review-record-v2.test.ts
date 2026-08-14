import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { validateReviewRecord } from '../../../../scripts/pr-human-review/validate-record.mjs';
import {
  retainedLedgerHash,
  retainedLedgerProjection,
} from '../../../../scripts/pr-human-review/trusted-retained-legacy.mjs';

const mergeBaseSha = 'a'.repeat(40);
const initialHeadSha = 'b'.repeat(40);
const finalHeadSha = 'c'.repeat(40);
const currentHeadSha = 'd'.repeat(40);
const initialPlanDigest = '1'.repeat(64);
const currentPlanDigest = '2'.repeat(64);
const buildTreeDigest = '3'.repeat(64);

describe('PR Human Review Record v2', () => {
  it('accepts a draft whose initial architecture review and checkpoint are complete', () => {
    const record = reviewRecord();

    const errors = validateReviewRecord(validationInput(record));

    expect(errors).toEqual([]);
  });

  it('requires a code-changing review to identify an active plan', () => {
    const input = validationInput(reviewRecord());

    expect(
      validateReviewRecord({
        ...input,
        currentPlan: { ...input.currentPlan, status: 'postponed' },
      }),
    ).toContain('code-changing review must identify an active adaptive plan');
  });

  it('accepts the canonical template after its visible fields and metadata are filled', () => {
    const record = reviewRecord();

    const errors = validateReviewRecord({
      ...validationInput(record),
      body: filledCanonicalTemplate(record),
    });

    expect(errors).toEqual([]);
  });

  it('rejects v1 metadata instead of retaining a transition parser', () => {
    const v1Body = [
      '## PR Human Review Record v1',
      '```pr-human-review-record-v1',
      JSON.stringify({ version: 1, scope: 'code-changing' }),
      '```',
    ].join('\n');

    const errors = validateReviewRecord({ ...validationInput(reviewRecord()), body: v1Body });

    expect(errors).toContain('PR Human Review Record v2 must contain exactly one metadata fence');
  });

  it('rejects v1 and unknown top-level transition fields for each scope', () => {
    const codeChanging = reviewRecord() as unknown as Record<string, unknown>;
    codeChanging.milestoneReview = { classification: 'none' };
    const exempt = {
      version: 2,
      scope: 'exempt',
      exemption: { kind: 'documentation-only', changedPaths: ['docs/guide.md'] },
      retainedLegacy: [],
      initialReview: null,
    };

    expect(
      validateReviewRecord({
        ...validationInput(reviewRecord()),
        body: metadataOnlyBody(codeChanging),
      }),
    ).toContain('code-changing review metadata contains unsupported fields: milestoneReview');
    expect(
      validateReviewRecord({
        ...validationInput(reviewRecord()),
        body: metadataOnlyBody(exempt),
        changedPaths: ['docs/guide.md'],
      }),
    ).toContain('exempt review metadata contains unsupported fields: initialReview');
  });

  it('rejects trailing content after the only metadata fence', () => {
    const body = `${recordBody(reviewRecord())}\n\n### Unvalidated narrative\nContinue anyway.\n`;

    expect(validateReviewRecord({ ...validationInput(reviewRecord()), body })).toContain(
      'PR Human Review Record v2 metadata fence must end the pull request body',
    );
  });

  it('accepts repository-wide ordinary Markdown exemptions but rejects tested documentation', () => {
    const ordinaryDocumentation = exemptRecordBody('packages/example/README.md');
    const testedDocumentation = exemptRecordBody('apps/api-v1/README.md');

    expect(
      validateReviewRecord({
        ...validationInput(reviewRecord()),
        body: ordinaryDocumentation,
        changedPaths: ['packages/example/README.md'],
      }),
    ).toEqual([]);
    expect(
      validateReviewRecord({
        ...validationInput(reviewRecord()),
        body: testedDocumentation,
        changedPaths: ['apps/api-v1/README.md'],
      }),
    ).toContain('documentation-only exemption path is not allowed: apps/api-v1/README.md');
  });

  it('admits only canonical direct closure receipts through the plan-only exemption', () => {
    const canonicalReceipt = 'plans/adaptive-agent-execution-governance.closure.json';

    expect(
      validateReviewRecord({
        ...validationInput(reviewRecord()),
        body: exemptRecordBody(canonicalReceipt, 'plan-only'),
        changedPaths: [canonicalReceipt],
      }),
    ).toEqual([]);

    expect(
      validateReviewRecord({
        ...validationInput(reviewRecord()),
        body: exemptRecordBody('plans/policy.json', 'plan-only'),
        changedPaths: ['plans/policy.json'],
      }),
    ).toEqual([]);

    for (const rejectedPath of [
      'plans/arbitrary.json',
      'plans/nested/fixture-plan.closure.json',
      'plans/../fixture-plan.closure.json',
      'scripts/fixture-plan.closure.json',
    ]) {
      expect(
        validateReviewRecord({
          ...validationInput(reviewRecord()),
          body: exemptRecordBody(rejectedPath, 'plan-only'),
          changedPaths: [rejectedPath],
        }),
      ).not.toEqual([]);
    }

    for (const noncanonicalPath of [
      './plans/adaptive-agent-execution-governance.closure.json',
      'plans//adaptive-agent-execution-governance.closure.json',
    ]) {
      expect(
        validateReviewRecord({
          ...validationInput(reviewRecord()),
          body: exemptRecordBody(noncanonicalPath, 'plan-only'),
          changedPaths: [canonicalReceipt],
        }),
      ).toContain('exemption changed paths must be normalized repository-relative paths');
      expect(
        validateReviewRecord({
          ...validationInput(reviewRecord()),
          body: exemptRecordBody(canonicalReceipt, 'plan-only'),
          changedPaths: [noncanonicalPath],
        }),
      ).toContain('observed changed paths must be normalized repository-relative paths');
    }

    expect(
      validateReviewRecord({
        ...validationInput(reviewRecord()),
        body: metadataOnlyBody({
          version: 2,
          scope: 'exempt',
          exemption: {
            kind: 'plan-only',
            changedPaths: [canonicalReceipt, 'scripts/change.mjs'],
          },
          retainedLegacy: [],
        }),
        changedPaths: [canonicalReceipt, 'scripts/change.mjs'],
      }),
    ).toContain('plan-only exemption path is not allowed: scripts/change.mjs');
  });

  it('requires the initial review to cover the plan goal, acceptance, capability tree, owner entries, and first horizon', () => {
    const missingGoal = reviewRecord({
      initialReview: { ...initialReview(), goal: '' },
    });
    const tooManySlices = reviewRecord({
      initialReview: {
        ...initialReview(),
        firstSlices: ['slice-one', 'slice-two', 'slice-three'],
      },
    });

    expect(validateReviewRecord(validationInput(missingGoal))).toContain(
      'initial review goal is required',
    );
    expect(validateReviewRecord(validationInput(tooManySlices))).toContain(
      'initial review firstSlices must contain one or two slices',
    );
  });

  it('binds every initial architecture field to the adaptive plan at the reviewed head', () => {
    const staleDigest = reviewRecord({
      initialReview: { ...initialReview(), adaptivePlanDigest: '9'.repeat(64) },
    });
    const inventedOwner = reviewRecord({
      initialReview: {
        ...initialReview(),
        canonicalOwnerEntries: [{ owner: 'invented', entry: 'scripts/invented.mjs' }],
      },
    });

    expect(validateReviewRecord(validationInput(staleDigest))).toContain(
      'initial review adaptive-plan digest must match the reviewed plan',
    );
    expect(validateReviewRecord(validationInput(inventedOwner))).toContain(
      'initial review canonical owners and entries must match the reviewed plan',
    );
  });

  it('keeps the checkpoint review to the current adaptive-plan digest', () => {
    const stale = reviewRecord({
      checkpointReview: { adaptivePlanDigest: '4'.repeat(64) },
    });
    const narrativeSmuggling = reviewRecord({
      checkpointReview: {
        adaptivePlanDigest: currentPlanDigest,
        milestoneNarrative: 'Repeated milestone prose.',
      },
    });

    expect(validateReviewRecord(validationInput(stale))).toContain(
      'checkpoint review adaptive-plan digest must match the current plan',
    );
    expect(validateReviewRecord(validationInput(narrativeSmuggling))).toContain(
      'checkpoint review contains unsupported fields: milestoneNarrative',
    );

    const visibleNarrative = recordBody(reviewRecord()).replace(
      `- Current adaptive-plan digest: ${currentPlanDigest}`,
      [
        `- Current adaptive-plan digest: ${currentPlanDigest}`,
        '### Milestone review',
        '- Decision narrative: Continue because the last milestone passed.',
      ].join('\n'),
    );
    expect(
      validateReviewRecord({ ...validationInput(reviewRecord()), body: visibleNarrative }),
    ).toContain('visible checkpoint review must contain only the current adaptive-plan digest');
  });

  it('accepts a ready review after an unrelated documentation-only commit', () => {
    const record = reviewRecord({ finalReview: finalReview() });
    const input = validationInput(record, false);

    const errors = validateReviewRecord(input);

    expect(errors).toEqual([]);
  });

  it('accepts a receipt-authenticated retained ledger without PR-only approval fields', () => {
    const item = {
      id: 'production-legacy-example',
      path: 'apps/example/compat.ts',
      symbol: 'compatibilityEntry',
      classification: 'legacy',
      disposition: 'retained-pending-human-approval',
    };
    const approval = {
      id: item.id,
      path: item.path,
      symbol: item.symbol,
      purpose: 'Retain compatibility during the documented migration.',
      consumerDependency: 'A named downstream consumer still calls this entry.',
      unsafeRemovalReason: 'The downstream migration has not completed.',
      minimization: 'The entry delegates directly to the canonical owner.',
      canonicalOwner: 'apps/example/canonical.ts#createCanonicalEntry',
      compatibilityTests: 'packages/tests/example/compatibility.test.ts',
      owner: 'Example team',
      removalCondition: 'Remove after the downstream migration completes.',
      approvedProductionSha: currentHeadSha,
      ledgerSha256: '',
    };
    approval.ledgerSha256 = retainedLedgerHash({ item, approval });
    const initial = { ...initialReview(), legacy: { candidateCount: 1, items: [item] } };
    const final = {
      ...finalReview(),
      legacy: {
        candidateCount: 1,
        items: [item],
        candidatesInspected: 'Baseline, report, diff, and call paths.',
      },
    };
    const record = reviewRecord({ initialReview: initial, finalReview: final });
    (record.retainedLegacy as Array<Record<string, unknown>>).push(approval);
    const projection = retainedLedgerProjection({
      items: [item],
      approvalById: new Map([[item.id, approval]]),
    });
    const errors = validateReviewRecord({
      ...validationInput(record, false),
      registry: '# Production Legacy Exception Registry\n',
      readGovernanceExceptions: () => [
        {
          decisionId: 'e'.repeat(64),
          projection: {
            retainedLedgerProjection: projection,
            ledgerSha256: approval.ledgerSha256,
            approvedProductionSha: currentHeadSha,
            candidateHead: currentHeadSha,
          },
        },
      ],
    });

    expect(errors).toEqual([]);

    const malformedErrors = validateReviewRecord({
      ...validationInput(record, false),
      registry: [
        '# Production Legacy Exception Registry',
        '### production-legacy-unrelated',
        '- Purpose: This unrelated entry omits required fields.',
      ].join('\n'),
      readGovernanceExceptions: () => [
        {
          decisionId: 'e'.repeat(64),
          projection: {
            retainedLedgerProjection: projection,
            ledgerSha256: approval.ledgerSha256,
            approvedProductionSha: currentHeadSha,
            candidateHead: currentHeadSha,
          },
        },
      ],
    });

    expect(malformedErrors).toContain(
      'retained legacy registry Repository-relative path and symbol is malformed: production-legacy-unrelated',
    );
  });

  it('invalidates the final review when build content or current plan decisions change', () => {
    const staleBuild = reviewRecord({
      finalReview: {
        ...finalReview(),
        freshness: { ...finalReview().freshness, buildTreeDigest: '4'.repeat(64) },
      },
    });
    const staleStructure = reviewRecord({
      finalReview: {
        ...finalReview(),
        freshness: {
          ...finalReview().freshness,
          structuralDecision: 'Continue with an obsolete capability tree.',
        },
      },
    });

    expect(validateReviewRecord(validationInput(staleBuild, false))).toContain(
      'final review build-affecting tree digest must match the current tree',
    );
    expect(validateReviewRecord(validationInput(staleStructure, false))).toContain(
      'final review structural decision must match the current adaptive plan',
    );
  });

  it('requires the final reviewer to cover every declared owner-to-result path and completion judgment', () => {
    const missingOwner = finalReview();
    missingOwner.ownerToResultPaths = missingOwner.ownerToResultPaths.slice(0, 1);
    const record = reviewRecord({ finalReview: missingOwner });

    const errors = validateReviewRecord(validationInput(record, false));

    expect(errors).toContain(
      'final review owner-to-result paths must cover every declared capability owner and entry',
    );
    for (const field of [
      'declaredOutcomes',
      'navigationEvidence',
      'testEvidence',
      'compatibilityEvidence',
      'proportionalValidation',
      'touchedFileStandardsClosure',
      'legacyClosure',
    ]) {
      const incomplete = finalReview() as unknown as Record<string, unknown>;
      incomplete[field] = '';
      expect(
        validateReviewRecord(
          validationInput(reviewRecord({ finalReview: incomplete as never }), false),
        ),
      ).toContain(`final review ${field} is required`);
    }
  });

  it('requires non-placeholder touched-file standards closure evidence that matches the visible review', () => {
    const record = reviewRecord({
      finalReview: { ...finalReview(), touchedFileStandardsClosure: 'TODO' },
    });
    const contradictedVisibleEvidence = recordBody(record).replace(
      `- Touched-file standards closure: ${record.finalReview?.touchedFileStandardsClosure}`,
      '- Touched-file standards closure: The reviewer inspected only the changed production files.',
    );

    const errors = validateReviewRecord({
      ...validationInput(record, false),
      body: contradictedVisibleEvidence,
    });

    expect(errors).toContain(
      'final review touchedFileStandardsClosure contains placeholder evidence',
    );
    expect(errors).toContain(
      'visible final review contradicts metadata: touchedFileStandardsClosure',
    );
  }, 30_000);

  it('binds visible initial, checkpoint, and final evidence to metadata', () => {
    const record = reviewRecord({ finalReview: finalReview() });
    const contradicted = recordBody(record).replace(
      `- Current adaptive-plan digest: ${currentPlanDigest}`,
      `- Current adaptive-plan digest: ${'9'.repeat(64)}`,
    );

    const errors = validateReviewRecord({
      ...validationInput(record, false),
      body: contradicted,
    });

    expect(errors).toContain('visible checkpoint review contradicts metadata: adaptivePlanDigest');
  });
});

function validationInput(record: ReturnType<typeof reviewRecord>, draft = true) {
  return {
    body: recordBody(record),
    changedPaths: ['scripts/pr-human-review/validate-record.mjs'],
    registry: '# Production Legacy Exception Registry\n',
    trustedReviews: [],
    mergeBaseSha,
    headSha: currentHeadSha,
    draft,
    prAuthorLogin: 'pull-request-author',
    approvalHistory: {},
    currentPlan: {
      path: 'plans/example-plan.md',
      status: 'active',
      digest: currentPlanDigest,
      goal: 'Keep multi-slice implementation adaptive and reviewable.',
      acceptanceCriteria: [
        'A human can recover every capability owner from the repository.',
        'Review evidence stays fresh by content rather than commit identity.',
      ],
      structuralDecision: 'Keep the two active capability owners separate.',
      ownerEntries: [
        { owner: 'PR human review', entry: 'scripts/pr-human-review.mjs' },
        { owner: 'governance gate', entry: 'scripts/governance-gate.mjs' },
      ],
    },
    currentBuildTreeDigest: buildTreeDigest,
    reviewedBuildTreeDigestBySha: { [finalHeadSha]: buildTreeDigest },
    reviewedPlanContextBySha: {
      [initialHeadSha]: {
        digest: initialPlanDigest,
        goal: 'Keep multi-slice implementation adaptive and reviewable.',
        acceptanceCriteria: [
          'A human can recover every capability owner from the repository.',
          'Review evidence stays fresh by content rather than commit identity.',
        ],
        capabilityTreeHypothesis: 'Review evidence belongs to one explicit repository capability.',
        initialOwnerEntries: [
          { owner: 'PR human review', entry: 'scripts/pr-human-review.mjs' },
          { owner: 'governance gate', entry: 'scripts/governance-gate.mjs' },
        ],
        firstSlices: ['pr-human-review-record-v2', 'fast-governance-gate'],
      },
    },
  };
}

function reviewRecord(
  input: {
    readonly initialReview?: ReturnType<typeof initialReview>;
    readonly checkpointReview?: Record<string, unknown>;
    readonly finalReview?: ReturnType<typeof finalReview> | null;
  } = {},
) {
  return {
    version: 2,
    scope: 'code-changing',
    exemption: null,
    plan: { path: 'plans/example-plan.md' },
    initialReview: input.initialReview ?? initialReview(),
    checkpointReview: input.checkpointReview ?? { adaptivePlanDigest: currentPlanDigest },
    finalReview: input.finalReview ?? null,
    retainedLegacy: [],
  };
}

function initialReview() {
  return {
    status: 'complete',
    reviewer: 'Fresh architecture reviewer',
    independence: 'separate-agent-or-human',
    adaptivePlanDigest: initialPlanDigest,
    mergeBaseSha,
    headSha: initialHeadSha,
    goal: 'Keep multi-slice implementation adaptive and reviewable.',
    acceptanceCriteria: [
      'A human can recover every capability owner from the repository.',
      'Review evidence stays fresh by content rather than commit identity.',
    ],
    capabilityTreeHypothesis: 'Review evidence belongs to one explicit repository capability.',
    canonicalOwnerEntries: [
      { owner: 'PR human review', entry: 'scripts/pr-human-review.mjs' },
      { owner: 'governance gate', entry: 'scripts/governance-gate.mjs' },
    ],
    firstSlices: ['pr-human-review-record-v2', 'fast-governance-gate'],
    completeFindings: 'No Critical or Important architecture findings remain.',
    automationGaps: 'Automation cannot approve the architectural hypothesis.',
    unresolvedFindings: { critical: 0, important: 0 },
    verdict: 'pass',
    legacy: legacyLedger(),
  };
}

function finalReview() {
  return {
    reviewer: 'Fresh final reviewer',
    independence: 'separate-agent-or-human',
    mergeBaseSha,
    headSha: finalHeadSha,
    freshness: {
      buildTreeDigest,
      planGoal: 'Keep multi-slice implementation adaptive and reviewable.',
      acceptanceCriteria: [
        'A human can recover every capability owner from the repository.',
        'Review evidence stays fresh by content rather than commit identity.',
      ],
      structuralDecision: 'Keep the two active capability owners separate.',
    },
    declaredOutcomes: 'Both declared governance outcomes were traced from owner to result.',
    ownerToResultPaths: [
      {
        owner: 'PR human review',
        entry: 'scripts/pr-human-review.mjs',
        result: 'The command reports a deterministic review verdict.',
        trace: 'CLI to record parser to evidence and retained-legacy validation.',
      },
      {
        owner: 'governance gate',
        entry: 'scripts/governance-gate.mjs',
        result: 'The command reports phase-specific governance results.',
        trace: 'CLI to ordered governance phases to the process exit.',
      },
    ],
    navigationEvidence: 'Fresh navigation located every owner, result, failure, and mirrored test.',
    testEvidence: 'Focused semantic and repository-governance tests passed.',
    compatibilityEvidence: 'Public behavior and trusted retained-legacy semantics were preserved.',
    proportionalValidation: 'Focused local governance ran; broad build validation remains in CI.',
    touchedFileStandardsClosure:
      'Every changed human-authored code file was reviewed in full, recursive modified-support-file remediation is complete, and every remaining signal is a demonstrated false positive or linked human-approved exception.',
    legacyClosure: 'Every affected legacy candidate has one final disposition.',
    completeFindings: 'No Critical or Important correctness or contract findings remain.',
    automationGaps: 'Automation cannot approve semantic review quality.',
    unresolvedFindings: { critical: 0, important: 0 },
    verdict: 'pass',
    legacy: { ...legacyLedger(), candidatesInspected: 'Baseline, report, diff, and call paths.' },
  };
}

function legacyLedger() {
  return { candidateCount: 0, items: [] as Record<string, unknown>[] };
}

function exemptRecordBody(changedPath: string, kind = 'documentation-only'): string {
  return metadataOnlyBody({
    version: 2,
    scope: 'exempt',
    exemption: { kind, changedPaths: [changedPath] },
    retainedLegacy: [],
  });
}

function metadataOnlyBody(record: Record<string, unknown>): string {
  return [
    '## PR Human Review Record v2',
    '```pr-human-review-record-v2',
    JSON.stringify(record, null, 2),
    '```',
  ].join('\n');
}

function recordBody(record: ReturnType<typeof reviewRecord>): string {
  const initial = record.initialReview;
  const final = record.finalReview;
  return [
    '## PR Human Review Record v2',
    '### Initial architecture review',
    `- Record status: ${initial.status}`,
    `- Reviewer and independence (separate agent or human): ${initial.reviewer} — ${initial.independence}`,
    `- Reviewed adaptive-plan digest: ${initial.adaptivePlanDigest}`,
    `- Goal: ${initial.goal}`,
    `- Acceptance criteria: ${JSON.stringify(initial.acceptanceCriteria)}`,
    `- Capability-tree hypothesis: ${initial.capabilityTreeHypothesis}`,
    `- Canonical owners and entries: ${JSON.stringify(initial.canonicalOwnerEntries)}`,
    `- First two slices: ${JSON.stringify(initial.firstSlices)}`,
    `- Complete review findings and resolution/status: ${initial.completeFindings}`,
    `- Behavior and judgment not proven by automation: ${initial.automationGaps}`,
    `- Legacy candidate count: ${initial.legacy.candidateCount}`,
    `- Legacy ledger and dispositions: ${JSON.stringify(initial.legacy.items)}`,
    `- Critical findings unresolved: ${initial.unresolvedFindings.critical}`,
    `- Important findings unresolved: ${initial.unresolvedFindings.important}`,
    `- Verdict: ${initial.verdict}`,
    '### Current checkpoint review',
    `- Current adaptive-plan digest: ${record.checkpointReview.adaptivePlanDigest}`,
    '### Complete code, structure, tests, and legacy review',
    ...(final
      ? [
          `- Reviewer and independence (separate agent or human): ${final.reviewer} — ${final.independence}`,
          `- Build-affecting tree digest: ${final.freshness.buildTreeDigest}`,
          `- Plan goal: ${final.freshness.planGoal}`,
          `- Acceptance criteria: ${JSON.stringify(final.freshness.acceptanceCriteria)}`,
          `- Current structural decision: ${final.freshness.structuralDecision}`,
          `- Declared outcomes: ${final.declaredOutcomes}`,
          `- Owner-to-result paths: ${JSON.stringify(final.ownerToResultPaths)}`,
          `- Navigation evidence: ${final.navigationEvidence}`,
          `- Test evidence: ${final.testEvidence}`,
          `- Compatibility evidence: ${final.compatibilityEvidence}`,
          `- Proportional validation: ${final.proportionalValidation}`,
          `- Touched-file standards closure: ${final.touchedFileStandardsClosure}`,
          `- Legacy closure: ${final.legacyClosure}`,
          `- Complete review findings and resolution/status: ${final.completeFindings}`,
          `- Behavior and judgment not proven by automation: ${final.automationGaps}`,
          `- Legacy candidates inspected (baseline, automated report, changed files, and production call paths): ${final.legacy.candidatesInspected}`,
          `- Legacy candidate count: ${final.legacy.candidateCount}`,
          `- Legacy ledger and dispositions: ${JSON.stringify(
            retainedLedgerProjection({
              items: final.legacy.items,
              approvalById: new Map(
                record.retainedLegacy.map((approval) => [approval?.id, approval]),
              ),
            }),
          )}`,
          `- Critical findings unresolved: ${final.unresolvedFindings.critical}`,
          `- Important findings unresolved: ${final.unresolvedFindings.important}`,
          `- Verdict: ${final.verdict}`,
        ]
      : []),
    '```pr-human-review-record-v2',
    JSON.stringify(record, null, 2),
    '```',
  ].join('\n');
}

function filledCanonicalTemplate(record: ReturnType<typeof reviewRecord>): string {
  const headings = [
    '### Initial architecture review',
    '### Current checkpoint review',
    '### Complete code, structure, tests, and legacy review',
  ];
  const generatedBody = recordBody(record);
  let template = readFileSync('.github/PULL_REQUEST_TEMPLATE.md', 'utf8');
  for (const heading of headings) {
    const templateSection = headingSection(template, heading);
    const generatedSection = headingSection(generatedBody, heading);
    const filledSection = generatedSection
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .reduce((section, line) => replaceVisibleField(section, line), templateSection);
    template = template.replace(templateSection, filledSection);
  }
  return template.replace(
    /```pr-human-review-record-v2\s*\n[\s\S]*?\n```/u,
    ['```pr-human-review-record-v2', JSON.stringify(record, null, 2), '```'].join('\n'),
  );
}

function headingSection(body: string, heading: string): string {
  const start = body.indexOf(heading);
  const contentStart = start + heading.length;
  const nextHeadingOffset = body.slice(contentStart).search(/^### /mu);
  const end = nextHeadingOffset === -1 ? body.length : contentStart + nextHeadingOffset;
  return body.slice(start, end);
}

function replaceVisibleField(section: string, sourceLine: string): string {
  const colon = sourceLine.indexOf(':');
  const label = sourceLine.slice(2, colon).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return section.replace(new RegExp(`^- ${label}:.*$`, 'mu'), sourceLine);
}

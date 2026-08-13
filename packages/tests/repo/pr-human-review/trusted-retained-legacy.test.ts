import { describe, expect, it } from 'vitest';

import {
  retainedLedgerHash,
  retainedLedgerProjection,
  validateRetainedLegacy,
} from '../../../../scripts/pr-human-review/trusted-retained-legacy.mjs';

const productionSha = 'a'.repeat(40);

describe('trusted retained-legacy approval', () => {
  it('accepts a complete sorted ledger bound by an authorized human approval and registry', () => {
    const fixture = retainedFixture();
    const { approval: _approval, item: _item, ...validationInput } = fixture;
    const errors: string[] = [];

    validateRetainedLegacy({ ...validationInput, errors });

    expect(errors).toEqual([]);
  });

  it('rejects bot approval and a hash that does not bind the complete ledger', () => {
    const fixture = retainedFixture();
    const { approval: _approval, item: _item, ...validationInput } = fixture;
    const botErrors: string[] = [];
    validateRetainedLegacy({
      ...validationInput,
      trustedReviews: [
        {
          ...fixture.trustedReviews[0],
          user: { type: 'Bot', login: fixture.approval.reviewerLogin },
        },
      ],
      errors: botErrors,
    });
    expect(botErrors).toContain(
      `trusted GitHub review is not an approved human reviewer: ${fixture.item.id}`,
    );

    const hashErrors: string[] = [];
    validateRetainedLegacy({
      ...validationInput,
      record: {
        ...fixture.record,
        retainedLegacy: [{ ...fixture.approval, ledgerSha256: 'f'.repeat(64) }],
      },
      errors: hashErrors,
    });
    expect(hashErrors).toContain(
      `retained legacy ledger hash does not match the final ledger: ${fixture.item.id}`,
    );
  });

  it.each([
    {
      name: 'a reviewer without repository authority',
      review: { author_association: 'CONTRIBUTOR' },
      prAuthorLogin: 'pull-request-author',
      expected: 'trusted GitHub review is not a repository-authorized reviewer',
    },
    {
      name: 'the pull request author',
      review: {},
      prAuthorLogin: 'trusted-human',
      expected: 'trusted GitHub reviewer must not be the pull request author',
    },
  ])('rejects $name', ({ review, prAuthorLogin, expected }) => {
    const fixture = retainedFixture();
    const { approval: _approval, item: _item, ...validationInput } = fixture;
    const errors: string[] = [];

    validateRetainedLegacy({
      ...validationInput,
      trustedReviews: [{ ...fixture.trustedReviews[0], ...review }],
      prAuthorLogin,
      errors,
    });

    expect(errors).toContain(`${expected}: ${fixture.item.id}`);
  });

  it.each(['CHANGES_REQUESTED', 'DISMISSED', 'APPROVED'])(
    'rejects an approval superseded by a later %s review',
    (state) => {
      const fixture = retainedFixture();
      const { approval: _approval, item: _item, ...validationInput } = fixture;
      const errors: string[] = [];

      validateRetainedLegacy({
        ...validationInput,
        trustedReviews: [
          fixture.trustedReviews[0],
          {
            ...fixture.trustedReviews[0],
            id: fixture.approval.reviewId + 1,
            state,
            submitted_at: '2026-08-12T00:01:00Z',
          },
        ],
        errors,
      });

      expect(errors).toContain(
        `trusted GitHub review is not the actor's latest effective substantive review: ${fixture.item.id}`,
      );
    },
  );

  it('rejects divergent history and post-approval paths outside registry evidence', () => {
    const fixture = retainedFixture();
    const { approval: _approval, item: _item, ...validationInput } = fixture;
    const currentHead = 'b'.repeat(40);
    const divergentErrors: string[] = [];
    validateRetainedLegacy({
      ...validationInput,
      headSha: currentHead,
      approvalHistory: {
        [productionSha]: {
          isAncestor: false,
          changedPaths: ['docs/production-legacy-exceptions.md'],
        },
      },
      errors: divergentErrors,
    });
    expect(divergentErrors).toContain(`post-approval path evidence is missing: ${fixture.item.id}`);

    const productionErrors: string[] = [];
    validateRetainedLegacy({
      ...validationInput,
      headSha: currentHead,
      approvalHistory: {
        [productionSha]: { isAncestor: true, changedPaths: ['apps/example/compat.ts'] },
      },
      errors: productionErrors,
    });
    expect(productionErrors).toContain(
      `production change invalidates retained legacy approval: ${fixture.item.id}`,
    );
  });

  it('keeps approval valid when only its durable registry evidence follows the approved SHA', () => {
    const fixture = retainedFixture();
    const { approval: _approval, item: _item, ...validationInput } = fixture;
    const errors: string[] = [];

    validateRetainedLegacy({
      ...validationInput,
      headSha: 'b'.repeat(40),
      approvalHistory: {
        [productionSha]: {
          isAncestor: true,
          changedPaths: ['docs/production-legacy-exceptions.md'],
        },
      },
      errors,
    });

    expect(errors).toEqual([]);
  });

  it('accepts an exact receipt-bound retained ledger without PR review or registry authentication', () => {
    const fixture = retainedFixture();
    const { approval: _approval, item: _item, ...validationInput } = fixture;
    const projection = retainedLedgerProjection({
      items: fixture.finalReview.legacy.items,
      approvalById: new Map([[fixture.approval.id, fixture.approval]]),
    });
    const errors: string[] = [];

    validateRetainedLegacy({
      ...validationInput,
      trustedReviews: [],
      registry: fixture.registry,
      readGovernanceExceptions: (selector: Record<string, unknown>) => {
        expect(selector).toEqual({
          exceptionKind: 'production-legacy',
          candidateHead: productionSha,
        });
        return [
          {
            decisionId: 'd'.repeat(64),
            projection: {
              retainedLedgerProjection: projection,
              ledgerSha256: retainedLedgerHash({
                items: fixture.finalReview.legacy.items,
                approvalById: new Map([[fixture.approval.id, fixture.approval]]),
              }),
              approvedProductionSha: productionSha,
              candidateHead: productionSha,
            },
          },
        ];
      },
      errors,
    });

    expect(errors).toEqual([]);
  });

  it('keeps malformed registry evidence visible beside a matching receipt approval', () => {
    const fixture = retainedFixture();
    const { approval: _approval, item: _item, ...validationInput } = fixture;
    const errors: string[] = [];
    validateRetainedLegacy({
      ...validationInput,
      trustedReviews: [],
      registry: [
        '# Production Legacy Exception Registry',
        '### production-legacy-unrelated',
        '- Purpose: This unrelated section omits required fields.',
      ].join('\n'),
      readGovernanceExceptions: () => [receiptApproval(fixture)],
      errors,
    });

    expect(errors).toContain(
      'retained legacy registry Repository-relative path and symbol is malformed: production-legacy-unrelated',
    );
  });

  it('keeps malformed governance resolver evidence visible and unauthorized', () => {
    const fixture = retainedFixture();
    const { approval: _approval, item: _item, ...validationInput } = fixture;
    const errors: string[] = [];

    validateRetainedLegacy({
      ...validationInput,
      trustedReviews: [],
      readGovernanceExceptions: () => ({ decisions: [] }),
      errors,
    });

    expect(errors).toContain(
      'governance exception resolver returned malformed production legacy evidence',
    );
  });

  it('requires every retained approval and trusted review to bind the complete sorted ledger', () => {
    const fixture = retainedFixture();
    const secondItem = {
      ...fixture.item,
      id: 'production-legacy-second',
      path: 'apps/example/second-compat.ts',
      symbol: 'secondCompatibilityEntry',
    };
    const secondApproval = {
      ...fixture.approval,
      id: secondItem.id,
      path: secondItem.path,
      symbol: secondItem.symbol,
    };
    const items = [secondItem, fixture.item];
    const approvalById = new Map([
      [fixture.approval.id, fixture.approval],
      [secondApproval.id, secondApproval],
    ]);
    const ledgerSha256 = retainedLedgerHash({ items, approvalById });
    fixture.approval.ledgerSha256 = ledgerSha256;
    secondApproval.ledgerSha256 = ledgerSha256;
    const record = { retainedLegacy: [fixture.approval, secondApproval] };
    const finalReview = { legacy: { candidateCount: 2, items } };
    const trustedReviews = [
      trustedReview(
        fixture.approval,
        items.map((item) => item.id),
      ),
    ];
    const input = {
      record,
      finalReview,
      trustedReviews,
      prAuthorLogin: fixture.prAuthorLogin,
      headSha: fixture.headSha,
      approvalHistory: fixture.approvalHistory,
      registry: `${registryEntry(fixture.approval)}\n${registryEntry(secondApproval)}`,
    };
    const validErrors: string[] = [];

    validateRetainedLegacy({ ...input, errors: validErrors });
    expect(validErrors).toEqual([]);

    const fragmentedErrors: string[] = [];
    validateRetainedLegacy({
      ...input,
      record: {
        retainedLegacy: [
          fixture.approval,
          {
            ...secondApproval,
            ledgerSha256: retainedLedgerHash({
              items: [secondItem],
              approvalById: new Map([[secondApproval.id, secondApproval]]),
            }),
          },
        ],
      },
      errors: fragmentedErrors,
    });
    expect(fragmentedErrors).toContain(
      `retained legacy ledger hash does not match the final ledger: ${secondItem.id}`,
    );
  });
});

function retainedFixture() {
  const item = {
    id: 'production-legacy-example',
    path: 'apps/example/compat.ts',
    symbol: 'compatibilityEntry',
    classification: 'legacy',
    disposition: 'retained-pending-human-approval',
    rationale: 'The named downstream client still requires this compatibility entry.',
  };
  const approval = {
    id: item.id,
    path: item.path,
    symbol: item.symbol,
    purpose: 'Retain the documented compatibility entry during migration.',
    consumerDependency: 'A named client still invokes this entry.',
    unsafeRemovalReason: 'That client migration has not completed.',
    minimization: 'The entry delegates directly to the canonical implementation.',
    canonicalOwner: 'apps/example/canonical.ts#createCanonicalEntry',
    compatibilityTests: 'packages/tests/example/compatibility.test.ts',
    owner: 'Example team',
    removalCondition: 'Remove after the named client migration completes.',
    approvedProductionSha: productionSha,
    reviewId: 42,
    reviewerLogin: 'trusted-human',
    approvalDate: '2026-08-12T00:00:00Z',
    ledgerSha256: '',
  };
  approval.ledgerSha256 = retainedLedgerHash({ item, approval });
  const reviewBody = [
    'PR-HUMAN-REVIEW-LEGACY-APPROVAL v1',
    `production-sha: ${productionSha}`,
    `ledger-sha256: ${approval.ledgerSha256}`,
    `legacy-ids: ${item.id}`,
  ].join('\n');
  const registry = registryEntry(approval);
  const finalReview = { legacy: { candidateCount: 1, items: [item] } };
  return {
    item,
    approval,
    record: { retainedLegacy: [approval] },
    finalReview,
    trustedReviews: [
      {
        id: approval.reviewId,
        state: 'APPROVED',
        commit_id: productionSha,
        submitted_at: approval.approvalDate,
        user: { type: 'User', login: approval.reviewerLogin },
        author_association: 'MEMBER',
        body: reviewBody,
      },
    ],
    prAuthorLogin: 'pull-request-author',
    headSha: productionSha,
    approvalHistory: {},
    registry,
  };
}

function registryEntry(approval: ReturnType<typeof retainedFixture>['approval']): string {
  return [
    '# Production Legacy Exception Registry',
    `### ${approval.id}`,
    `- Repository-relative path and symbol: ${approval.path}#${approval.symbol}`,
    `- Purpose: ${approval.purpose}`,
    `- Canonical implementation owner: ${approval.canonicalOwner}`,
    `- Consumer or operational dependency: ${approval.consumerDependency}`,
    `- Why removal is unsafe now: ${approval.unsafeRemovalReason}`,
    `- Minimization already performed: ${approval.minimization}`,
    `- Approval date and human reviewer: ${approval.approvalDate} — ${approval.reviewerLogin}`,
    `- Approved production candidate SHA: ${approval.approvedProductionSha}`,
    `- Compatibility tests: ${approval.compatibilityTests}`,
    `- Named owner: ${approval.owner}`,
    `- Review or removal condition: ${approval.removalCondition}`,
    `- GitHub PR review ID: ${approval.reviewId}`,
  ].join('\n');
}

function trustedReview(
  approval: ReturnType<typeof retainedFixture>['approval'],
  itemIds: readonly string[],
) {
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
      `legacy-ids: ${[...itemIds].sort().join(',')}`,
    ].join('\n'),
  };
}

function receiptApproval(fixture: ReturnType<typeof retainedFixture>) {
  return {
    decisionId: 'd'.repeat(64),
    projection: {
      retainedLedgerProjection: retainedLedgerProjection({
        items: fixture.finalReview.legacy.items,
        approvalById: new Map([[fixture.approval.id, fixture.approval]]),
      }),
      ledgerSha256: retainedLedgerHash({
        items: fixture.finalReview.legacy.items,
        approvalById: new Map([[fixture.approval.id, fixture.approval]]),
      }),
      approvedProductionSha: productionSha,
      candidateHead: productionSha,
    },
  };
}

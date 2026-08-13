export function createGovernanceDecisionFixturePlanRecord(diffBase = 'HEAD'): any {
  return {
    version: 1,
    planId: 'governance-decision-fixture',
    status: 'active',
    goal: 'Exercise deterministic governance decisions.',
    acceptanceCriteria: ['Every governed transition remains content-bound.'],
    capabilities: [
      {
        owner: 'authenticated governance decisions',
        root: 'scripts/governance-decisions',
        entry: 'scripts/governance-decisions.mjs',
        testRoot: 'packages/tests/repo/governance-decisions',
        focusedCommand: 'npm run test:governance-decisions',
        navigationMap: 'scripts/governance-decisions/README.md',
        factContracts: [],
        controlFlowFamilies: ['request and transition', 'commit verification'],
        activation: { state: 'planned', slice: 'governance-decision-core' },
      },
    ],
    architecture: {
      currentHypothesis: 'The fixture requires an administrative disposition.',
      intendedHypothesis: 'One deterministic core owns the disposition.',
      invalidatedAssumptions: [],
      freshInitialReview: { status: 'complete', reviewer: 'fixture', verdict: 'pass' },
    },
    completedSlicesSinceCheckpoint: [],
    facts: {
      diffBase,
      affectedCodeDigest: null,
      computedTriggers: [],
      undeclaredChangedPaths: [],
    },
    checkpoint: {
      outcome: 'The fixture plan is active.',
      learning: 'The fixture has one owner.',
      structure: 'The fixture ownership is direct.',
      decision: 'continue',
      nextSlices: ['governance-decision-core'],
    },
    structuralDispositions: [],
    freshStructuralReview: null,
    coldNavigationEvidence: null,
    materialDecisions: [],
  };
}

export function toGovernanceDecisionFixturePlanMarkdown(diffBase = 'HEAD'): string {
  return `# Governance decision fixture\n\n\`\`\`plan-adaptation-v1\n${JSON.stringify(
    createGovernanceDecisionFixturePlanRecord(diffBase),
    null,
    2,
  )}\n\`\`\`\n`;
}

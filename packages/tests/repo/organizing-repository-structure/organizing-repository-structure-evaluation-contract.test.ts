import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const evaluationRoot = '.agents/evaluations/organizing-repository-structure/v1';
const scenarioIds = [
  'flat-versus-singleton-folders',
  'near-limit-module-pressure',
  'repository-depends-on-plan',
] as const;
const forbiddenPromptFragments = [
  'keep, split, move, or consolidate',
  'canonical structural facts',
  'cold-navigation',
  'automated facts',
  'structural judgment',
  'folder taxonomy',
] as const;

describe('organizing repository structure evaluation contract', () => {
  it('owns three versioned critical pressure scenarios', () => {
    const suite = readJson(`${evaluationRoot}/scenarios.json`) as EvaluationSuite;

    expect(suite.schemaVersion).toBe('organizing-repository-structure-scenarios-v1');
    expect(suite.suiteId).toBe('organizing-repository-structure-v1');
    expect(suite.execution).toEqual({
      repositoryRootResolution: 'suite-checkout',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      forkTurns: 'none',
      singleShot: true,
    });
    expect(suite.scenarios.map((scenario) => scenario.id).sort()).toEqual([...scenarioIds].sort());
    for (const scenario of suite.scenarios) {
      expect(scenario.critical, scenario.id).toBe(true);
      expect(scenario.primarySkill, scenario.id).toBe('organizing-repository-structure');
      expect(scenario.pressures.length, scenario.id).toBeGreaterThanOrEqual(3);
      expect(scenario.prompt.length, scenario.id).toBeGreaterThan(200);
      expect(new Set(scenario.requiredDimensions).size, scenario.id).toBe(
        scenario.requiredDimensions.length,
      );
      expect(existsSync(path.join(repoRoot, scenario.target.repositoryPath)), scenario.id).toBe(
        true,
      );
      expect(existsSync(path.join(repoRoot, scenario.target.pressurePath)), scenario.id).toBe(true);
      expect(['plan adaptation', 'repository structure'], scenario.id).toContain(
        scenario.target.capabilityOwner,
      );
      expect(scenario.prompt, scenario.id).toContain(scenario.target.repositoryPath);
      for (const fragment of forbiddenPromptFragments) {
        expect(scenario.prompt.toLowerCase(), `${scenario.id}: ${fragment}`).not.toContain(
          fragment,
        );
      }
    }
  });

  it('keeps concrete expected repository truth in the rubric instead of the prompts', () => {
    const suite = readJson(`${evaluationRoot}/scenarios.json`) as EvaluationSuite;
    const rubric = readJson(`${evaluationRoot}/rubric.json`) as EvaluationRubric;

    expect(Object.keys(rubric.scenarioExpectations).sort()).toEqual([...scenarioIds].sort());
    for (const scenario of suite.scenarios) {
      const expected = rubric.scenarioExpectations[scenario.id];
      const promptWithoutEvidenceCommand = scenario.prompt.replace(
        /run `node scripts\/repo-structure-check\.mjs --navigation-evidence [^`]+`, /u,
        '',
      );
      expect(expected, scenario.id).toBeDefined();
      expect(expected.owner.repositoryPath, scenario.id).toBe(scenario.target.repositoryPath);
      expect(expected.owner.capabilityOwner, scenario.id).toBe(scenario.target.capabilityOwner);
      expect(scenario.prompt, scenario.id).toContain(`run \`${scenario.target.evidenceCommand}\``);
      for (const reference of [
        expected.entry,
        expected.failure,
        expected.tests,
        expected.focusedCommand,
        expected.navigationMap,
      ]) {
        expect(reference.path, `${scenario.id}: ${reference.path}`).toMatch(/\S/u);
        if (reference.kind === 'symbol') {
          expect(reference.symbol, `${scenario.id}: ${reference.path}`).toMatch(/\S/u);
        }
        expect(
          promptWithoutEvidenceCommand,
          `${scenario.id}: leaked ${reference.path}`,
        ).not.toContain(reference.path);
        expectReferenceResolves(reference, scenario.id);
      }
      expect(expected.acceptedResults.length, scenario.id).toBeGreaterThan(0);
      for (const reference of expected.acceptedResults) {
        expectReferenceResolves(reference, scenario.id);
        expect(
          promptWithoutEvidenceCommand,
          `${scenario.id}: leaked ${reference.path}`,
        ).not.toContain(reference.path);
      }
      for (const reference of expected.trace) {
        expectReferenceResolves(reference, scenario.id);
        if (reference.path !== scenario.target.pressurePath) {
          expect(
            promptWithoutEvidenceCommand,
            `${scenario.id}: leaked ${reference.path}`,
          ).not.toContain(reference.path);
        }
      }
      for (const dimensionId of scenario.requiredDimensions) {
        const passText = rubric.dimensions.find((dimension) => dimension.id === dimensionId)?.pass;
        expect(passText, `${scenario.id}: ${dimensionId}`).toBeDefined();
        expect(scenario.prompt, `${scenario.id}: leaked ${dimensionId}`).not.toContain(passText);
      }
    }
  });

  it('scopes the plan-dependency pressure to source navigation, not runtime input', () => {
    const suite = readJson(`${evaluationRoot}/scenarios.json`) as EvaluationSuite;
    const scenario = suite.scenarios.find(({ id }) => id === 'repository-depends-on-plan');

    expect(scenario?.prompt).toContain(
      'Assess whether a maintainer can recover source ownership and control flow from code and durable repository documentation.',
    );
    expect(scenario?.prompt).toContain(
      'Runtime input availability is outside this navigation question.',
    );
    const promptWithoutEvidenceCommand = scenario?.prompt.replace(
      /run `node scripts\/repo-structure-check\.mjs --navigation-evidence [^`]+`, /u,
      '',
    );
    expect(promptWithoutEvidenceCommand).not.toMatch(
      /scripts\/repo-structure-check\.(?:mjs|test)/u,
    );
  });

  it('records explicit terminal alternatives and planless closure outcomes', () => {
    const rubric = readJson(`${evaluationRoot}/rubric.json`) as EvaluationRubric;
    const near = rubric.scenarioExpectations['near-limit-module-pressure'];
    const flat = rubric.scenarioExpectations['flat-versus-singleton-folders'];
    const planless = rubric.scenarioExpectations['repository-depends-on-plan'];

    expect(near.acceptedResults).toHaveLength(1);
    expect(near.acceptedResults[0]).toMatchObject({
      path: 'scripts/repo-structure-check.mjs',
      symbol: 'printResult',
    });
    expect(flat.acceptedResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: 'writePlanAndRegistry' }),
        expect.objectContaining({ symbol: 'prepareAdaptivePlan' }),
        expect.objectContaining({ symbol: 'checkAdaptivePlans' }),
        expect.objectContaining({ symbol: 'closeAdaptivePlan' }),
      ]),
    );
    expect(planless.acceptedResults).toEqual([
      expect.objectContaining({
        path: 'scripts/repo-structure-check.mjs',
        symbol: 'printResult',
      }),
    ]);
    expect(planless.acceptedClosureOutcomes).toEqual([
      'close-without-source-change',
      'clarify-durable-navigation-map-before-close',
    ]);
  });

  it('publishes one reproducible neutral 5+5 microtest contract', () => {
    const config = readJson(`${evaluationRoot}/microtests.json`) as MicrotestConfig;

    expect(config.schemaVersion).toBe('organizing-repository-structure-microtests-v1');
    expect(config.repetitionsPerVariant).toBe(5);
    expect(config.variants).toEqual(['no-skill', 'with-skill']);
    expect(config.freshContext).toEqual({ forkTurns: 'none', singleShot: true });
    expect(config.model).toMatch(/\S/u);
    expect(config.repositoryRootResolution).toBe('suite-checkout');
    expect(JSON.stringify(config)).not.toContain(repoRoot);
    expect(config.skillInput).toBe('.agents/skills/organizing-repository-structure/SKILL.md');
    expect(config.prompt).toContain(config.target.repositoryPath);
    for (const fragment of forbiddenPromptFragments) {
      expect(config.prompt.toLowerCase(), fragment).not.toContain(fragment);
    }
    expect(config.requiredDimensions).toEqual(
      expect.arrayContaining([
        'micro.exact-owner-entry',
        'micro.result-failure-paths',
        'micro.mirrored-tests',
        'micro.focused-command',
        'micro.navigation-map',
        'micro.evidence-based-decision',
      ]),
    );
    expect(
      config.scoring['micro.result-failure-paths'].acceptedResultSymbols.length,
    ).toBeGreaterThan(1);
    for (const reference of config.scoring['micro.result-failure-paths'].acceptedResultSymbols) {
      expectReferenceResolves(reference, 'micro.result-failure-paths');
    }
    expectReferenceResolves(
      config.scoring['micro.result-failure-paths'].requiredFailureSymbol,
      'micro.result-failure-paths',
    );
    expect(config.evidenceContract).toEqual({
      schemaVersion: 'organizing-repository-structure-evidence-ledger-v1',
      digestAlgorithm: 'sha256',
      repositoryRootPolicy: 'resolved-suite-checkout-in-ignored-ledger-only',
      rawOutputPolicy: 'verbatim-agent-response-separate-from-navigation-evidence-stdout-artifact',
      scorePolicy: 'separate-artifact',
      requiredFields: [
        'runId',
        'variant',
        'scenarioId',
        'startedAt',
        'completedAt',
        'model',
        'reasoningEffort',
        'forkTurns',
        'singleShot',
        'resolvedRepositoryRoot',
        'promptDigest',
        'skillDigest',
        'rubricDigest',
        'status',
        'rawOutputArtifact',
        'scoreArtifact',
        'navigationEvidenceCommand',
        'navigationEvidenceStartedAt',
        'navigationEvidenceCompletedAt',
        'navigationEvidenceExitCode',
        'navigationEvidenceArtifact',
        'navigationEvidenceDigest',
        'navigationEvidenceSchemaVersion',
        'navigationEvidenceOwner',
        'navigationEvidenceAffectedCodeDigest',
      ],
      statuses: ['running', 'completed', 'failed', 'invalid', 'aborted'],
    });
  });

  it('grades owner navigation, judgment, cold proof, and fact boundaries', () => {
    const suite = readJson(`${evaluationRoot}/scenarios.json`) as EvaluationSuite;
    const rubric = readJson(`${evaluationRoot}/rubric.json`) as EvaluationRubric;
    const dimensionIds = rubric.dimensions.map((dimension) => dimension.id);

    expect(rubric.schemaVersion).toBe('organizing-repository-structure-rubric-v1');
    expect(rubric.suiteId).toBe(suite.suiteId);
    expect(dimensionIds).toEqual(
      expect.arrayContaining([
        'structure.owner-navigation',
        'structure.disposition-judgment',
        'structure.singleton-tradeoff',
        'structure.navigation-proof',
        'structure.durable-repository-truth',
        'boundary.fact-versus-judgment',
      ]),
    );
    expect(rubric.nonGoals).toEqual(
      expect.arrayContaining([
        'Require a particular folder taxonomy.',
        'Convert a size, density, prefix, or depth fact into an automatic split.',
      ]),
    );
    for (const scenario of suite.scenarios) {
      expect(scenario.requiredDimensions, scenario.id).toContain('structure.owner-navigation');
      expect(scenario.requiredDimensions, scenario.id).toContain('structure.disposition-judgment');
      expect(scenario.requiredDimensions, scenario.id).toContain('boundary.fact-versus-judgment');
    }
    const ownerPass = rubric.dimensions.find(({ id }) => id === 'structure.owner-navigation')?.pass;
    const proofPass = rubric.dimensions.find(({ id }) => id === 'structure.navigation-proof')?.pass;
    expect(ownerPass).toContain('repository-navigation-evidence-v1 record');
    expect(proofPass).toContain('valid current record');
    expect(`${ownerPass} ${proofPass}`).not.toMatch(/Names .*exact|Supplies exact/iu);
  });

  it('assigns computed facts to automation and dispositions to the agent', () => {
    const rubric = readJson(`${evaluationRoot}/rubric.json`) as EvaluationRubric;

    expect(rubric.authority.automatedFacts).toEqual(
      expect.arrayContaining([
        'directory density',
        'feature-prefix clustering',
        'file size and cognitive-load findings',
        'semantic directory depth',
        'singleton and redundant-chain findings',
        'capability declaration and navigation-evidence validity',
      ]),
    );
    expect(rubric.authority.agentJudgments).toEqual(
      expect.arrayContaining([
        'capability and responsibility ownership',
        'keep, split, move, or consolidate disposition',
        'checkpoint decision and validation scope',
      ]),
    );
  });

  it('reuses the canonical result contract shape', () => {
    const rubric = readJson(`${evaluationRoot}/rubric.json`) as EvaluationRubric;

    expect(rubric.resultContract.schemaVersion).toBe('adaptive-agent-execution-result-v1');
    expect(rubric.resultContract.skillVariants).toEqual(['no-skill', 'with-skill']);
    expect(rubric.resultContract.verdicts).toEqual(['pass', 'fail']);
    expect(rubric.resultContract.requiredDimensionFields).toEqual([
      'dimensionId',
      'verdict',
      'evidence',
      'reason',
    ]);
  });
});

interface EvaluationSuite {
  readonly schemaVersion: string;
  readonly suiteId: string;
  readonly execution: {
    readonly repositoryRootResolution: string;
    readonly model: string;
    readonly reasoningEffort: string;
    readonly forkTurns: string;
    readonly singleShot: boolean;
  };
  readonly scenarios: readonly {
    readonly id: string;
    readonly critical: boolean;
    readonly primarySkill: string;
    readonly pressures: readonly string[];
    readonly prompt: string;
    readonly requiredDimensions: readonly string[];
    readonly target: {
      readonly repositoryPath: string;
      readonly pressurePath: string;
      readonly capabilityOwner: string;
      readonly evidenceCommand: string;
    };
  }[];
}

interface EvaluationRubric {
  readonly schemaVersion: string;
  readonly suiteId: string;
  readonly nonGoals: readonly string[];
  readonly authority: {
    readonly automatedFacts: readonly string[];
    readonly agentJudgments: readonly string[];
  };
  readonly dimensions: readonly { readonly id: string; readonly pass: string }[];
  readonly scenarioExpectations: Readonly<
    Record<
      string,
      {
        readonly owner: {
          readonly repositoryPath: string;
          readonly capabilityOwner: string;
        };
        readonly entry: ExpectedReference;
        readonly acceptedResults: readonly ExpectedReference[];
        readonly failure: ExpectedReference;
        readonly trace: readonly ExpectedReference[];
        readonly tests: ExpectedReference;
        readonly focusedCommand: ExpectedReference;
        readonly navigationMap: ExpectedReference;
        readonly acceptedClosureOutcomes?: readonly string[];
      }
    >
  >;
  readonly resultContract: {
    readonly schemaVersion: string;
    readonly skillVariants: readonly string[];
    readonly verdicts: readonly string[];
    readonly requiredDimensionFields: readonly string[];
  };
}

interface ExpectedReference {
  readonly kind: 'absence' | 'command' | 'path' | 'symbol';
  readonly path: string;
  readonly symbol?: string;
}

interface MicrotestConfig {
  readonly schemaVersion: string;
  readonly repetitionsPerVariant: number;
  readonly variants: readonly string[];
  readonly freshContext: { readonly forkTurns: string; readonly singleShot: boolean };
  readonly model: string;
  readonly repositoryRootResolution: string;
  readonly skillInput: string;
  readonly prompt: string;
  readonly target: { readonly repositoryPath: string };
  readonly requiredDimensions: readonly string[];
  readonly scoring: {
    readonly 'micro.result-failure-paths': {
      readonly acceptedResultSymbols: readonly ExpectedReference[];
      readonly requiredFailureSymbol: ExpectedReference;
      readonly pass: string;
    };
  };
  readonly evidenceContract: {
    readonly schemaVersion: string;
    readonly digestAlgorithm: string;
    readonly repositoryRootPolicy: string;
    readonly rawOutputPolicy: string;
    readonly scorePolicy: string;
    readonly requiredFields: readonly string[];
    readonly statuses: readonly string[];
  };
}

function readJson(repositoryPath: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, repositoryPath), 'utf8'));
}

function expectReferenceResolves(reference: ExpectedReference, scenarioId: string): void {
  const absolutePath = path.join(repoRoot, reference.path);
  if (reference.kind === 'absence') {
    expect(existsSync(absolutePath), `${scenarioId}: ${reference.path}`).toBe(false);
    return;
  }
  expect(existsSync(absolutePath), `${scenarioId}: ${reference.path}`).toBe(true);
  if (reference.kind === 'symbol' || reference.kind === 'command') {
    expect(readFileSync(absolutePath, 'utf8'), `${scenarioId}: ${reference.symbol}`).toContain(
      reference.symbol,
    );
  }
}

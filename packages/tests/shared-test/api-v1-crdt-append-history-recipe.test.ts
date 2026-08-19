import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  analyzeCrdtAppendHistoryReport,
  CRDT_APPEND_HISTORY_CASES,
  validateCrdtAppendHistoryArtifactCase,
} from '../../../scripts/perf/compare-api-v1-crdt-append-history-results.mjs';
import {
  readApiV1Matrix,
  readApiV1Recipe,
  toFlatApiV1RecipeSteps,
} from './api-v1-recipe-test-fixture.ts';

interface BlackBoxStep extends Readonly<Record<string, unknown>> {
  readonly name?: string;
  readonly type?: string;
  readonly count?: number | string;
  readonly connection?: string;
  readonly output?: string;
  readonly request?: Readonly<Record<string, unknown>>;
  readonly expect?: Readonly<Record<string, unknown>>;
  readonly steps?: readonly BlackBoxStep[];
}

interface CrdtAppendHistoryRecipe extends Readonly<Record<string, unknown>> {
  readonly variables: Readonly<Record<string, unknown>>;
  readonly steps: readonly BlackBoxStep[];
}

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const scenarioCli = path.join(
  repoRoot,
  'packages/shared-test/black-box-runner/scenario-black-box.ts',
);
const recipePath =
  'packages/shared-test/black-box-runner/tests/api-v1/api-v1-crdt-append-history.json';

describe('API-v1 CRDT append-history black-box evidence', () => {
  it('registers one parameterized recipe at the three bounded history scales', () => {
    const entries = readApiV1Matrix().entries.filter((entry) =>
      entry.profiles.includes('api-v1-black-box-crdt-append-history'),
    );

    expect(entries).toHaveLength(3);
    expect(
      entries.map((entry) => ({
        id: entry.id,
        recipe: entry.recipe,
        artifactName: entry.artifactName,
        historySize: entry.env?.RALLAR_CRDT_HISTORY_SIZE,
        finalHistorySize: entry.env?.RALLAR_CRDT_FINAL_HISTORY_SIZE,
        finalPreviousSequence: entry.env?.RALLAR_CRDT_FINAL_PREVIOUS_SEQUENCE,
      })),
    ).toEqual([
      {
        id: 'api-v1-crdt-append-history-small',
        recipe: 'tests/api-v1/api-v1-crdt-append-history.json',
        artifactName: 'api-v1-crdt-append-history-small',
        historySize: '10',
        finalHistorySize: '30',
        finalPreviousSequence: '29',
      },
      {
        id: 'api-v1-crdt-append-history-medium',
        recipe: 'tests/api-v1/api-v1-crdt-append-history.json',
        artifactName: 'api-v1-crdt-append-history-medium',
        historySize: '100',
        finalHistorySize: '120',
        finalPreviousSequence: '119',
      },
      {
        id: 'api-v1-crdt-append-history-large',
        recipe: 'tests/api-v1/api-v1-crdt-append-history.json',
        artifactName: 'api-v1-crdt-append-history-large',
        historySize: '480',
        finalHistorySize: '500',
        finalPreviousSequence: '499',
      },
    ]);
  });

  it('separates setup, replay warmup, measured operations, and final durable evidence', () => {
    const recipeValue = readApiV1Recipe('tests/api-v1/api-v1-crdt-append-history.json');
    if (!isCrdtAppendHistoryRecipe(recipeValue)) {
      throw new TypeError('CRDT append-history recipe must contain variables and object steps');
    }
    const recipe = recipeValue;
    const steps = toFlatApiV1RecipeSteps(recipe.steps);
    const step = (name: string) => steps.find((candidate) => candidate.name === name);

    expect(recipe.variables).toMatchObject({
      historySize: { env: 'RALLAR_CRDT_HISTORY_SIZE', required: true },
      expectedFinalHistorySize: {
        env: 'RALLAR_CRDT_FINAL_HISTORY_SIZE',
        required: true,
      },
      finalPreviousSequence: {
        env: 'RALLAR_CRDT_FINAL_PREVIOUS_SEQUENCE',
        required: true,
      },
    });
    expect(step('seedCrdtHistory')).toMatchObject({ type: 'loop', count: '{historySize}' });
    expect(step('warmDuplicateReplay')).toMatchObject({ type: 'loop', count: 3 });
    expect(step('measureNewAppends')).toMatchObject({ type: 'loop', count: 20 });
    expect(step('measureDuplicateReplays')).toMatchObject({ type: 'loop', count: 20 });
    expect(step('measureDuplicateReplay{loop.iteration}')).toMatchObject({
      type: 'ws.send',
      request: {
        send: {
          id: {
            msgId: 'crdt-history-{historySize}-replay-{loop.iteration}-{runId}',
          },
          route: {
            resourceId: 'crdt-history-{historySize}-seed-{historySize}-{runId}',
          },
        },
      },
    });
    expect(step('verifyFinalHistoryIntegrity')).toMatchObject({
      type: 'http',
      expect: {
        body: {
          ok: true,
          result: { valid: true, checkedUpdateCount: '{expectedFinalHistorySizeNumber}' },
        },
      },
    });
    expect(step('readFinalCrdtUpdateThroughTertiary')).toMatchObject({
      type: 'http',
      request: { body: { afterSequence: '{finalPreviousSequenceNumber}', maxUpdateCount: 1 } },
    });
    expect(step('exposeFinalStateWriteEvidence')).toMatchObject({
      type: 'set.state-write-evidence',
      request: {
        stateWriteEvidence: { match: 'crdt-history-{historySize}-new-20-{runId}' },
      },
    });
  });

  it('strictly expands every case with its exact loop count', () => {
    for (const testCase of CRDT_APPEND_HISTORY_CASES) {
      const result = spawnSync(
        'deno',
        ['run', '-A', scenarioCli, '-c', recipePath, '--validate', '--strict'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            RALLAR_CRDT_HISTORY_SIZE: String(testCase.seedHistorySize),
            RALLAR_CRDT_FINAL_HISTORY_SIZE: String(testCase.finalHistorySize),
            RALLAR_CRDT_FINAL_PREVIOUS_SEQUENCE: String(testCase.finalHistorySize - 1),
          },
        },
      );

      expect(result.status, `${testCase.name}: ${result.stderr}`).toBe(0);
    }
  });

  it('derives 20 end-to-end samples for new appends and duplicate replays', () => {
    const evidence = analyzeCrdtAppendHistoryReport(
      createReport({ newDurationMs: 20, replayDurationMs: 12 }),
      CRDT_APPEND_HISTORY_CASES[0],
    );

    expect(evidence.issues).toEqual([]);
    expect(evidence.newAppend).toMatchObject({ count: 20, p50Ms: 20, p95Ms: 20 });
    expect(evidence.duplicateReplay).toMatchObject({ count: 20, p50Ms: 12, p95Ms: 12 });
  });

  it('authenticates the exact expanded case variables stored with each artifact', () => {
    const testCase = CRDT_APPEND_HISTORY_CASES[1];
    const expandedRecipe = {
      sourceConfig: recipePath,
      recipe: {
        variables: {
          historySize: '100',
          expectedFinalHistorySize: '120',
          finalPreviousSequence: '119',
        },
      },
    };

    expect(validateCrdtAppendHistoryArtifactCase(expandedRecipe, testCase)).toEqual([]);
    expandedRecipe.recipe.variables.historySize = '10';
    expect(validateCrdtAppendHistoryArtifactCase(expandedRecipe, testCase)).toEqual([
      'expanded recipe historySize must equal 100',
    ]);
  });

  it('rejects failed, unpaired, duplicate, and non-monotonic measurement results', () => {
    const valid = createReport({ newDurationMs: 20, replayDurationMs: 12 });
    const mutations = [
      (report: MutableArtifactReport) => {
        report.summary.failure = 1;
        report.resultsList[0].status = 'FAILURE';
      },
      (report: MutableArtifactReport) => {
        report.resultsList.pop();
      },
      (report: MutableArtifactReport) => {
        report.resultsList.push({ ...report.resultsList[0] });
      },
      (report: MutableArtifactReport) => {
        report.resultsList[1].endedAtEpochMs = report.resultsList[0].startedAtEpochMs - 1;
      },
      (report: MutableArtifactReport) => {
        report.resultsList.push({
          ...report.resultsList[0],
          name: 'measureNewAppend21',
        });
      },
    ];

    for (const mutate of mutations) {
      const malformed = structuredClone(valid);
      mutate(malformed);
      expect(
        analyzeCrdtAppendHistoryReport(malformed, CRDT_APPEND_HISTORY_CASES[0]).issues,
      ).not.toEqual([]);
    }
  });
});

function isCrdtAppendHistoryRecipe(
  value: Readonly<Record<string, unknown>>,
): value is CrdtAppendHistoryRecipe {
  return (
    isRecord(value.variables) &&
    Array.isArray(value.steps) &&
    value.steps.every((step) => isRecord(step))
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface CreateReportInput {
  readonly newDurationMs: number;
  readonly replayDurationMs: number;
}

interface MutableArtifactResult {
  name: string;
  status: 'FAILURE' | 'SUCCESS';
  startedAtEpochMs: number;
  endedAtEpochMs: number;
  durationMs: number;
}

interface MutableArtifactSummary {
  failure: number;
}

interface MutableArtifactReport {
  summary: MutableArtifactSummary;
  resultsList: MutableArtifactResult[];
}

function createReport(input: CreateReportInput): MutableArtifactReport {
  const resultsList: MutableArtifactResult[] = [];
  for (let iteration = 1; iteration <= 20; iteration += 1) {
    resultsList.push(
      ...createMeasurementPair({
        prefix: 'NewAppend',
        iteration,
        startedAtEpochMs: iteration * 1_000,
        durationMs: input.newDurationMs,
      }),
      ...createMeasurementPair({
        prefix: 'DuplicateReplay',
        iteration,
        startedAtEpochMs: 100_000 + iteration * 1_000,
        durationMs: input.replayDurationMs,
      }),
    );
  }
  return { summary: { failure: 0 }, resultsList };
}

interface CreateMeasurementPairInput {
  readonly prefix: 'DuplicateReplay' | 'NewAppend';
  readonly iteration: number;
  readonly startedAtEpochMs: number;
  readonly durationMs: number;
}

function createMeasurementPair(
  input: CreateMeasurementPairInput,
): readonly MutableArtifactResult[] {
  const replyStartedAtEpochMs = input.startedAtEpochMs + 1;
  const replyEndedAtEpochMs = input.startedAtEpochMs + input.durationMs;
  return [
    {
      name: `measure${input.prefix}${input.iteration}`,
      status: 'SUCCESS',
      startedAtEpochMs: input.startedAtEpochMs,
      endedAtEpochMs: replyStartedAtEpochMs,
      durationMs: 1,
    },
    {
      name: `observe${input.prefix}Reply${input.iteration}`,
      status: 'SUCCESS',
      startedAtEpochMs: replyStartedAtEpochMs,
      endedAtEpochMs: replyEndedAtEpochMs,
      durationMs: replyEndedAtEpochMs - replyStartedAtEpochMs,
    },
  ];
}

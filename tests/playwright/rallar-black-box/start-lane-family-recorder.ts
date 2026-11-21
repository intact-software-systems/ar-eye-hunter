import type { TestInfo } from '@playwright/test';

import type { AlmConformanceLaneFamily } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import {
    resolveAlmLaneScenarioOutcome,
    toAlmLaneFamilyResult,
    type AlmLaneFamilyOutcome,
    type AlmLaneFamilyResult,
    type AlmLaneRunIdentity
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/lane-result/alm-lane-result.ts';

export interface LaneFamilyRecorder {
    /** Runs one scenario's body and records its outcome; a thrown error is recorded and rethrown. */
    readonly runScenario: (scenarioKey: string, body: () => Promise<void>) => Promise<void>;
    readonly finish: (familyOutcome: 'passed' | 'failed') => Promise<void>;
}

export interface StartLaneFamilyRecorderInput {
    readonly testInfo: Pick<TestInfo, 'errors'>;
    readonly identity: AlmLaneRunIdentity;
    readonly family: AlmConformanceLaneFamily;
    readonly scenarioKeys: readonly string[];
    readonly writeResult: (result: AlmLaneFamilyResult) => Promise<void>;
}

/**
 * Writes the family's result with every scenario `not-run`, then again after each scenario and at the end, so a family
 * test cut off by its time limit still leaves the outcome of every scenario that ended.
 */
export async function startLaneFamilyRecorder(input: StartLaneFamilyRecorderInput): Promise<LaneFamilyRecorder> {
    const settled = new Map<string, 'passed' | 'failed'>();
    const writeFamilyResult = async (familyOutcome: AlmLaneFamilyOutcome): Promise<void> => {
        const { identity, family, scenarioKeys } = input;
        await input.writeResult(toAlmLaneFamilyResult({ identity, family, scenarioKeys, settled, familyOutcome }));
    };
    const settleScenario = async (scenarioKey: string, outcome: 'passed' | 'failed'): Promise<void> => {
        settled.set(scenarioKey, outcome);
        await writeFamilyResult('not-finished');
    };
    await writeFamilyResult('not-finished');
    return {
        runScenario: async (scenarioKey, body) => {
            const errorsBefore = input.testInfo.errors.length;
            const toOutcome = (threw: boolean): 'passed' | 'failed' =>
                resolveAlmLaneScenarioOutcome({ threw, errorsBefore, errorsAfter: input.testInfo.errors.length });
            try {
                await body();
            }
            catch (failure) {
                await settleScenario(scenarioKey, toOutcome(true));
                throw failure;
            }
            await settleScenario(scenarioKey, toOutcome(false));
        },
        finish: async (familyOutcome) => await writeFamilyResult(familyOutcome)
    };
}

import type { TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { toError } from '@shared/resilience/to-error.ts';

import type { AlmConformanceLaneFamily } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import {
    resolveAlmLaneScenarioOutcome,
    toAlmLaneFamilyResult,
    type AlmLaneFamilyOutcome,
    type AlmLaneFamilyResult,
    type AlmLanePlanRecord,
    type AlmLaneRunIdentity,
    type AlmLaneSettledScenarioOutcome
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/lane-result/alm-lane-result.ts';

export interface LaneFamilyRecorder {
    /** Runs one scenario's body and records its outcome; a thrown error is recorded and rethrown. */
    readonly runScenario: (scenarioKey: string, body: () => Promise<void>) => Promise<void>;
    /**
     * Runs the family test's whole body, from opening its run to closing it, and records the family's outcome: failed
     * when the body threw (the error is rethrown) or left an error on the test, passed otherwise.
     */
    readonly runFamily: (body: () => Promise<void>) => Promise<void>;
}

export interface StartLaneFamilyRecorderInput {
    readonly testInfo: Pick<TestInfo, 'errors'>;
    readonly identity: AlmLaneRunIdentity;
    readonly family: AlmConformanceLaneFamily;
    readonly scenarioKeys: readonly string[];
    readonly writeResult: (result: AlmLaneFamilyResult) => Promise<void>;
}

/**
 * Writes the family's result with every scenario `not-run`, then again after each scenario and when the family ends,
 * so a family test cut off by its time limit still leaves the outcome of every scenario that ended.
 */
export async function startLaneFamilyRecorder(input: StartLaneFamilyRecorderInput): Promise<LaneFamilyRecorder> {
    const settled = new Map<string, AlmLaneSettledScenarioOutcome>();
    const writeFamilyResult = async (familyOutcome: AlmLaneFamilyOutcome): Promise<void> => {
        const { identity, family, scenarioKeys } = input;
        await input.writeResult(toAlmLaneFamilyResult({ identity, family, scenarioKeys, settled, familyOutcome }));
    };
    const settleScenario = async (scenarioKey: string, outcome: AlmLaneSettledScenarioOutcome): Promise<void> => {
        settled.set(scenarioKey, outcome);
        await writeFamilyResult('not-finished');
    };
    await writeFamilyResult('not-finished');
    return {
        runScenario: async (scenarioKey, body) => {
            const errorsBefore = input.testInfo.errors.length;
            const toOutcome = (threw: boolean): AlmLaneSettledScenarioOutcome =>
                resolveAlmLaneScenarioOutcome({ threw, errorsBefore, errorsAfter: input.testInfo.errors.length });
            try {
                await body();
            }
            catch (failure) {
                return await writeBesideFailure(toError(failure), () => settleScenario(scenarioKey, toOutcome(true)));
            }
            await settleScenario(scenarioKey, toOutcome(false));
        },
        runFamily: async (body) => {
            try {
                await body();
            }
            catch (failure) {
                return await writeBesideFailure(toError(failure), () => writeFamilyResult('failed'));
            }
            await writeFamilyResult(input.testInfo.errors.length > 0 ? 'failed' : 'passed');
        }
    };
}

/**
 * Writes the file through a temporary file in the same directory and a rename, so a worker killed mid-write leaves the
 * previous complete file, never a partial one.
 */
export async function writeLaneResultFile(
    directory: string,
    fileName: string,
    value: AlmLaneFamilyResult | AlmLanePlanRecord
): Promise<void> {
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, fileName);
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
    await rename(temporaryPath, filePath);
}

/** Writes the result of a failed step and rethrows the step's own error, which a failing write never replaces. */
async function writeBesideFailure(failure: Error, write: () => Promise<void>): Promise<never> {
    try {
        await write();
    }
    catch (writeFailure) {
        console.warn('The ALM lane result could not be written; the step\'s own failure is reported.', {
            writeFailure
        });
    }
    throw failure;
}

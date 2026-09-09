import { expect, test, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

import {
    ALM_CONFORMANCE_CARRIERS,
    type AlmConformanceCarrier
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import {
    createTwoAgentRun,
    readFullStackConfig,
    runRecipePairOnTwoAgents,
    uniqueSuffix,
    type TwoAgentRun
} from './full-stack-helpers.ts';

const config = readFullStackConfig();
const scope = process.env.RALLAR_BLACK_BOX_ALM_SCOPE === 'full' ? 'full' : 'smoke';
const carriers = toCarrierSelection(process.env.RALLAR_BLACK_BOX_ALM_CARRIERS);

/** Comma-separated scenario ids withheld from the lane; each one needs a recorded ruling. */
const skippedScenarioIds = (process.env.RALLAR_BLACK_BOX_ALM_SKIP ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const CONFORMANCE_TYPE_ID = 'alm.conformance';
const CONFORMANCE_DEADLINE_MS = 15_000;
// 4 scenarios x 15s deadline x 2 (sender+receiver) + 60s RTC readiness = 180s expected; kept at
// 300s for the configured retry and slow-CI slack rather than rounded down to the expected figure.
const CARRIER_TEST_TIMEOUT_MS = 300_000;

/**
 * Every ensure command in the family builds the API mutation requestId
 * `alm-conformance-{runId}-<carrier>-<scenarioId>-<role>-<operation>-{runtimeIdentity}`, and the API
 * rejects a requestId longer than 128 characters. The longest carrier, scenario, role and operation
 * plus the 13-character runtime identity consume 85 of those, so the run id gets the other 43.
 */
const RUN_ID_BUDGET = 43;

/** Comma-separated carriers; empty runs every carrier. The CI scripts pass `ws` while a cold RTC handshake on a hosted runner reports no ready peer. */
function toCarrierSelection(value: string | undefined): readonly AlmConformanceCarrier[] {
    const requested = (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    if (requested.length === 0) {
        return ALM_CONFORMANCE_CARRIERS;
    }
    const unsupported = requested.filter((entry) => !isAlmConformanceCarrier(entry));
    if (unsupported.length > 0) {
        throw new RangeError(`RALLAR_BLACK_BOX_ALM_CARRIERS names unsupported carriers: ${unsupported.join(', ')}`);
    }
    return ALM_CONFORMANCE_CARRIERS.filter((carrier) => requested.includes(carrier));
}

function isAlmConformanceCarrier(value: string): value is AlmConformanceCarrier {
    return (ALM_CONFORMANCE_CARRIERS as readonly string[]).includes(value);
}

test.describe('ALM conformance lane', () => {
    // A cold RTC handshake intermittently reports no ready peer even within the widened readiness
    // budget; the retry costs one extra run of a carrier, and hosted runners select `ws` only.
    test.describe.configure({ retries: 1 });
    test.skip(!config.enabled, 'RALLAR_BLACK_BOX_FULL_STACK is not set');

    for (const carrier of carriers) {
        test(`baseline family over ${carrier} (${scope})`, async ({ browser, request }, testInfo) => {
            test.setTimeout(CARRIER_TEST_TIMEOUT_MS);

            const run = await createTwoAgentRun({
                browser,
                request,
                testInfo,
                runId: `alm-${carrier}-${uniqueSuffix()}`.slice(0, RUN_ID_BUDGET)
            });

            try {
                await runAlmConformanceScenarios(run, carrier);
            }
            finally {
                try {
                    await attachRunSnapshot(run, testInfo, `alm-${carrier}-${scope}.json`);
                }
                catch (attachError) {
                    console.warn('Failed to attach ALM conformance run snapshot', {
                        carrier,
                        runId: run.runId,
                        attachError
                    });
                }
                await run.close();
            }
        });
    }
});

/** Soft assertions so one run exercises every in-scope scenario and reports all of them. */
async function runAlmConformanceScenarios(
    run: TwoAgentRun,
    carrier: AlmConformanceCarrier
): Promise<void> {
    for (const scenario of selectScenarios(run, carrier)) {
        const outcome = await runRecipePairOnTwoAgents(run, scenario);
        expect.soft(outcome.receiver.ok, `${scenario.scenarioId} receiver: ${outcome.receiver.summary}`)
            .toBe(true);
        expect.soft(outcome.sender.ok, `${scenario.scenarioId} sender: ${outcome.sender.summary}`)
            .toBe(true);
    }
}

function selectScenarios(
    run: TwoAgentRun,
    carrier: AlmConformanceCarrier
): readonly AlmConformanceScenario[] {
    return createAlmConformanceRecipes({
        group: run.group,
        carrier,
        typeId: CONFORMANCE_TYPE_ID,
        senderConnection: run.sender.connection,
        receiverConnection: run.receiver.connection,
        deadlineMs: CONFORMANCE_DEADLINE_MS
    }).filter((scenario) =>
        (scope === 'full' || scenario.tags.includes('smoke')) &&
        !skippedScenarioIds.includes(scenario.scenarioId)
    );
}

async function attachRunSnapshot(
    run: TwoAgentRun,
    testInfo: TestInfo,
    fileName: string
): Promise<void> {
    const path = testInfo.outputPath(fileName);
    await writeFile(path, JSON.stringify(await run.readSnapshot(), null, 2), 'utf8');
    await testInfo.attach(fileName, { path, contentType: 'application/json' });
}

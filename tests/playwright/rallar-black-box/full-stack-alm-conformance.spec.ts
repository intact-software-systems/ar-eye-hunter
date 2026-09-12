import { expect, test, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
    ALM_CONFORMANCE_CARRIERS,
    type AlmConformanceCarrier
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { decodeALMObservationSnapshot } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts';
import {
    computeALMObservationRegime,
    createUnreadableALMObservationRegime,
    toALMObservationRegimeSummary,
    type ALMObservationCellOutcome,
    type ALMObservationRegime
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-regime.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { BROWSER_AL_RUNTIME_DB_NAME } from '../../../packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    runAlmNativeObservationLifecycle,
    type AlmNativeObservationArtifact
} from './browser-alm-native-observation.ts';
import {
    createTwoAgentRun,
    FULL_STACK_SPA_ORIGIN,
    readFullStackConfig,
    runRecipePairOnTwoAgents,
    uniqueSuffix,
    type ControlRunSnapshot,
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
const CONFORMANCE_DEADLINE_MS = 18_000;
const NATIVE_OBSERVATION_SAMPLE_CAPACITY = 50_000;
const NATIVE_RECORDER_MODULE_URL = `/@fs${
    path.resolve('tests/playwright/rallar-black-box/browser-native-indexeddb-timing-recorder.ts')
}`;
// 4 scenarios x 18s deadline x 2 (sender+receiver) + 60s RTC readiness = 204s expected; kept at
// 300s for slow-CI slack rather than rounded down to the expected figure.
const CARRIER_TEST_TIMEOUT_MS = 300_000;

/**
 * Playwright clears the output root once at the start of a run and deletes each passing test's own
 * output directory at the end, so a green cell's evidence only survives beside those directories,
 * not inside one. The observation job uploads the whole root, which carries this directory with it.
 */
const OBSERVATION_DIRECTORY_NAME = 'alm-observation';

/**
 * Every ensure command in the family builds the API mutation requestId
 * `alm-conformance-{runId}-<carrier>-<scenarioId>-<role>-<operation>-{runtimeIdentity}`, and the API
 * rejects a requestId longer than 128 characters. The longest carrier, scenario, role and operation
 * plus the 13-character runtime identity consume 85 of those, so the run id gets the other 43.
 */
const RUN_ID_BUDGET = 43;

interface RecordAlmObservationInput {
    readonly run: TwoAgentRun;
    readonly testInfo: TestInfo;
    readonly carrier: AlmConformanceCarrier;
    readonly cellOutcome: ALMObservationCellOutcome;
}

interface WriteAlmObservationFilesInput {
    readonly testInfo: TestInfo;
    readonly carrier: AlmConformanceCarrier;
    readonly regime: ALMObservationRegime;
    readonly snapshot: ControlRunSnapshot;
}

interface WriteAlmNativeObservationFileInput {
    readonly testInfo: TestInfo;
    readonly carrier: AlmConformanceCarrier;
    readonly artifact: AlmNativeObservationArtifact;
}

/** Comma-separated carriers; empty runs every carrier. Narrows a local or observation run to one carrier. */
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

            await runAlmNativeObservationLifecycle({
                runId: run.runId,
                carrier,
                scope,
                retry: testInfo.retry,
                databaseName: BROWSER_AL_RUNTIME_DB_NAME,
                sampleCapacity: NATIVE_OBSERVATION_SAMPLE_CAPACITY,
                recorderModuleUrl: NATIVE_RECORDER_MODULE_URL,
                sourceLabels: {
                    runtime: readSourceLabel('RALLAR_ALM_NATIVE_TIMING_SOURCE'),
                    instrumentation: readSourceLabel('RALLAR_ALM_NATIVE_TIMING_INSTRUMENTATION_SOURCE'),
                    servedSourceIdentity: 'unverified'
                },
                environment: {
                    nodeVersion: process.version,
                    platform: process.platform,
                    architecture: process.arch,
                    apiMode: process.env.RALLAR_BLACK_BOX_API_MODE?.trim() || 'unspecified',
                    apiBaseUrl: config.apiBaseUrl,
                    spaBaseUrl: FULL_STACK_SPA_ORIGIN,
                    workerCount: testInfo.config.workers
                },
                participants: [
                    { role: 'sender', agentId: run.sender.agentId, page: run.sender.page },
                    { role: 'receiver', agentId: run.receiver.agentId, page: run.receiver.page }
                ],
                runScenario: async () => await runAlmConformanceScenarios(run, carrier),
                writeNativeObservation: async (artifact) =>
                    await writeNativeObservationFile({
                        testInfo,
                        carrier,
                        artifact
                    }),
                recordControlObservation: async (scenarioFailed) =>
                    await recordObservation({
                        run,
                        testInfo,
                        carrier,
                        cellOutcome: toCellOutcome(testInfo, scenarioFailed)
                    }),
                closeRun: async () => await run.close()
            });
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

/** A cell records its regime whether it passed or failed, and never fails the cell for doing so. */
async function recordObservation(
    cell: RecordAlmObservationInput
): Promise<void> {
    try {
        const snapshot = await cell.run.readSnapshot();
        const regime = toObservationRegime(snapshot, cell.carrier, cell.cellOutcome);
        await writeObservationFiles({
            testInfo: cell.testInfo,
            carrier: cell.carrier,
            regime,
            snapshot
        });
        if (cell.cellOutcome === 'failed') {
            await attachRunSnapshot(snapshot, cell.testInfo, `alm-${cell.carrier}-${scope}.json`);
        }
        console.info(toALMObservationRegimeSummary(regime));
    }
    catch (observationError) {
        console.warn('Failed to record the ALM conformance observation', {
            carrier: cell.carrier,
            runId: cell.run.runId,
            observationError
        });
    }
}

function toObservationRegime(
    snapshot: ControlRunSnapshot,
    carrier: AlmConformanceCarrier,
    cellOutcome: ALMObservationCellOutcome
): ALMObservationRegime {
    return decodeALMObservationSnapshot(snapshot).fold(
        (snapshotIssues) => createUnreadableALMObservationRegime({ carrier, scope, cellOutcome, snapshotIssues }),
        (decoded) => computeALMObservationRegime({ snapshot: decoded, carrier, scope, cellOutcome })
    );
}

async function writeObservationFiles(
    observation: WriteAlmObservationFilesInput
): Promise<void> {
    const directory = path.join(
        observation.testInfo.project.outputDir,
        OBSERVATION_DIRECTORY_NAME
    );
    await mkdir(directory, { recursive: true });
    const fileName = toObservationFileName(observation.carrier, observation.testInfo.retry);
    await writeFile(
        path.join(directory, `${fileName}.json`),
        toJsonText(observation.regime),
        'utf8'
    );
    await writeFile(
        path.join(directory, `${fileName}-snapshot.json`),
        toJsonText(observation.snapshot),
        'utf8'
    );
}

async function writeNativeObservationFile(observation: WriteAlmNativeObservationFileInput): Promise<void> {
    const directory = path.join(
        observation.testInfo.project.outputDir,
        OBSERVATION_DIRECTORY_NAME
    );
    await mkdir(directory, { recursive: true });
    const fileName = toObservationFileName(observation.carrier, observation.testInfo.retry);
    await writeFile(
        path.join(directory, `${fileName}-native-indexeddb.json`),
        toJsonText(observation.artifact),
        'utf8'
    );
}

/** An unsuffixed name would let a retried cell overwrite the first attempt's regime and snapshot. */
function toObservationFileName(carrier: AlmConformanceCarrier, retry: number): string {
    return retry === 0 ? `${carrier}-${scope}` : `${carrier}-${scope}-retry${retry}`;
}

/** Kept for a failed cell's convenience: the snapshot is one click away in the Playwright report. */
async function attachRunSnapshot(
    snapshot: ControlRunSnapshot,
    testInfo: TestInfo,
    fileName: string
): Promise<void> {
    const attachmentPath = testInfo.outputPath(fileName);
    await writeFile(attachmentPath, toJsonText(snapshot), 'utf8');
    await testInfo.attach(fileName, { path: attachmentPath, contentType: 'application/json' });
}

/** Soft assertions record their failures on `testInfo` the moment they fire, before the cell ends. */
function toCellOutcome(testInfo: TestInfo, scenarioFailed: boolean): ALMObservationCellOutcome {
    return scenarioFailed || testInfo.errors.length > 0 ? 'failed' : 'passed';
}

function readSourceLabel(
    name: 'RALLAR_ALM_NATIVE_TIMING_SOURCE' | 'RALLAR_ALM_NATIVE_TIMING_INSTRUMENTATION_SOURCE'
): string {
    return process.env[name]?.trim() || process.env.GITHUB_SHA?.trim() || 'working-tree';
}

function toJsonText(
    value: ALMObservationRegime | ControlRunSnapshot | AlmNativeObservationArtifact
): string {
    return JSON.stringify(value, null, 2);
}

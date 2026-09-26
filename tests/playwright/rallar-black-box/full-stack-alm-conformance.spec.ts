import {
    expect,
    test,
    type Frame,
    type TestInfo
} from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
    ALM_CONFORMANCE_CARRIERS,
    type AlmConformanceCarrier
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { AlmConformanceRole } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import type { CreateAlmConformanceRecipesInput } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import {
    decodeALMObservationPageDiagnosticsFile,
    type ALMObservationPageDiagnosticsFile
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-page-diagnostics.ts';
import { decodeALMObservationSnapshot } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts';
import { assessAlmConformanceIdentity } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-conformance-identity.ts';
import {
    computeALMObservationRegime,
    createUnreadableALMObservationRegime,
    toALMObservationRegimeSummary,
    type ALMObservationCellOutcome,
    type ALMObservationRegime
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-regime.ts';
import {
    createAlmConformanceRecipes,
    isThreeAgentScenario,
    toAlmConformanceRoleRecipe,
    type AlmConformanceScenario
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { parseControlClientMessage } from '../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import {
    createTwoAgentRun,
    readFullStackConfig,
    runRecipePairOnTwoAgents,
    uniqueSuffix,
    type ControlRunSnapshot,
    type RecipePairOutcome,
    type RecipeRunOutcome,
    type TwoAgentRun,
    type TwoAgentRunParticipant
} from './full-stack-helpers.ts';
import {
    createThreeAgentRun,
    runRecipeTrioOnThreeAgents,
    type ThreeAgentRun
} from './full-stack-three-agent-run.ts';
import type { PageDiagnosticsCapture } from './start-page-diagnostics-capture.ts';
import { toPageDiagnosticsFile, type PageDiagnosticsFile } from './to-page-diagnostics-file.ts';

interface ObservationCell {
    readonly run: TwoAgentRun;
    readonly testInfo: TestInfo;
    readonly carrier: AlmConformanceCarrier;
    readonly cellOutcome: ALMObservationCellOutcome;
}

interface ScenarioRoleEvidence {
    readonly role: AlmConformanceRole;
    readonly agent: TwoAgentRunParticipant;
    readonly outcome: RecipeRunOutcome;
}

type ScenarioSelectionInput = Pick<
    CreateAlmConformanceRecipesInput,
    'group' | 'senderConnection' | 'receiverConnection'
>;

interface ObservationFiles {
    readonly testInfo: TestInfo;
    readonly carrier: AlmConformanceCarrier;
    readonly regime: ALMObservationRegime;
    readonly snapshot: ControlRunSnapshot;
    /** Undefined only when neither agent page ever attached a diagnostics capture. */
    readonly pageDiagnosticsFile: PageDiagnosticsFile | undefined;
}

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
// Finite carrier ceiling covers the conformance recipes and connection readiness: the next whole minute above the
// widest cell, rtc-with-ws-fallback in the full scope, measured at 4.8, 4.9 and 5.3 minutes.
const CARRIER_TEST_TIMEOUT_MS = 360_000;

/**
 * Playwright clears the output root once at the start of a run and deletes each passing test's own
 * output directory at the end, so a green cell's evidence only survives beside those directories,
 * not inside one. The observation job uploads the whole root, which carries this directory with it.
 */
const OBSERVATION_DIRECTORY_NAME = 'alm-observation';

test.describe('ALM conformance lane', () => {
    test.skip(!config.enabled, 'RALLAR_BLACK_BOX_FULL_STACK is not set');

    for (const carrier of carriers) {
        test(`baseline family over ${carrier} (${scope})`, async ({ browser, request }, testInfo) => {
            test.setTimeout(CARRIER_TEST_TIMEOUT_MS);

            const run = await createTwoAgentRun({
                browser,
                request,
                testInfo,
                runId: `alm-${carrier}-${uniqueSuffix()}`
            });

            let scenarioFailed = false;
            try {
                await runAlmConformanceScenarios(run, carrier);
            }
            catch (scenarioError) {
                scenarioFailed = true;
                throw scenarioError;
            }
            finally {
                await recordObservation({
                    run,
                    testInfo,
                    carrier,
                    cellOutcome: toCellOutcome(testInfo, scenarioFailed)
                });
                await run.close();
            }
        });

        test(`three-agent family over ${carrier} (${scope})`, async ({ browser, request }, testInfo) => {
            test.skip(
                selectScenarios(toPlanningSelection(), carrier, 'three-agent').length === 0,
                `no ${scope} ALM scenario over ${carrier} declares three roles`
            );
            test.setTimeout(CARRIER_TEST_TIMEOUT_MS);

            const run = await createThreeAgentRun({
                browser,
                request,
                testInfo,
                runId: `alm-${carrier}-three-agent-${uniqueSuffix()}`
            });
            try {
                await runThreeAgentScenarios(run, carrier);
            }
            finally {
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
    for (const scenario of selectScenarios(toRunSelection(run), carrier, 'two-agent')) {
        let senderNavigations = 0;
        let receiverNavigations = 0;
        const onSenderNavigation = (frame: Frame): void => {
            if (frame === run.sender.page.mainFrame()) {
                senderNavigations += 1;
            }
        };
        const onReceiverNavigation = (frame: Frame): void => {
            if (frame === run.receiver.page.mainFrame()) {
                receiverNavigations += 1;
            }
        };
        const reload = scenario.scenarioId === 'delivery-reload';
        if (reload) {
            run.sender.page.on('framenavigated', onSenderNavigation);
            run.receiver.page.on('framenavigated', onReceiverNavigation);
        }
        let outcome: RecipePairOutcome;
        try {
            outcome = await runRecipePairOnTwoAgents(run, scenario);
        }
        finally {
            if (reload) {
                run.sender.page.off('framenavigated', onSenderNavigation);
                run.receiver.page.off('framenavigated', onReceiverNavigation);
            }
        }
        if (reload) {
            expect.soft(senderNavigations, 'reload replaces the actual sender main-frame document once').toBe(1);
            expect.soft(receiverNavigations, 'receiver retains its document and subscriptions').toBe(0);
        }
        expect.soft(outcome.receiver.ok, `${scenario.scenarioKey} receiver: ${outcome.receiver.summary}`)
            .toBe(true);
        expect.soft(outcome.sender.ok, `${scenario.scenarioKey} sender: ${outcome.sender.summary}`)
            .toBe(true);
        if (hasIdentityEvidence(scenario)) {
            await assertScenarioIdentity(run, scenario, [
                { role: 'sender', agent: run.sender, outcome: outcome.sender },
                { role: 'receiver', agent: run.receiver, outcome: outcome.receiver }
            ]);
        }
    }
}

async function runThreeAgentScenarios(
    run: ThreeAgentRun,
    carrier: AlmConformanceCarrier
): Promise<void> {
    for (const scenario of selectScenarios(toRunSelection(run), carrier, 'three-agent')) {
        if (scenario.recipientB === undefined) {
            throw new Error(`${scenario.scenarioKey} declares three roles without a recipient-b recipe.`);
        }
        const outcome = await runRecipeTrioOnThreeAgents(run, { ...scenario, recipientB: scenario.recipientB });
        for (const role of ['receiver', 'recipientB', 'sender'] as const) {
            expect.soft(outcome[role].ok, `${scenario.scenarioKey} ${role}: ${outcome[role].summary}`).toBe(true);
        }
        if (hasIdentityEvidence(scenario)) {
            await assertScenarioIdentity(run, scenario, [
                { role: 'sender', agent: run.sender, outcome: outcome.sender },
                { role: 'receiver', agent: run.receiver, outcome: outcome.receiver },
                { role: 'recipient-b', agent: run.recipientB, outcome: outcome.recipientB }
            ]);
        }
    }
}

function hasIdentityEvidence(scenario: AlmConformanceScenario): boolean {
    return scenario.scenarioId === 'delivery-lifecycle' || scenario.scenarioId === 'delivery-reload';
}

async function assertScenarioIdentity(
    run: TwoAgentRun,
    scenario: AlmConformanceScenario,
    evidence: readonly ScenarioRoleEvidence[]
): Promise<void> {
    const snapshot = await run.readSnapshot();
    const issues = assessAlmConformanceIdentity({
        runId: run.runId,
        roles: scenario.roles,
        participants: evidence.flatMap(({ role, agent, outcome }) => {
            const recipe = toAlmConformanceRoleRecipe(scenario, role);
            const recorded = snapshot.results?.find((result) => result.commandId === outcome.commandId);
            const decoded = parseControlClientMessage(recorded);
            return recipe === undefined ? [] : [{
                role,
                agentId: agent.agentId,
                recipe,
                commandId: outcome.commandId,
                result: decoded.ok && decoded.envelope.kind === 'result' ? decoded.envelope : undefined
            }];
        })
    });
    expect.soft(issues, 'ALM actual identity evidence for every declared role').toEqual([]);
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

/** A scenario runs on the two-agent run unless it declares three roles (D45). */
function selectScenarios(
    selection: ScenarioSelectionInput,
    carrier: AlmConformanceCarrier,
    family: 'two-agent' | 'three-agent'
): readonly AlmConformanceScenario[] {
    return createAlmConformanceRecipes({
        ...selection,
        carrier,
        typeId: CONFORMANCE_TYPE_ID,
        deadlineMs: CONFORMANCE_DEADLINE_MS
    }).filter((scenario) =>
        isThreeAgentScenario(scenario) === (family === 'three-agent') &&
        (scope === 'full' || scenario.tags.includes('smoke')) &&
        !skippedScenarioIds.includes(scenario.scenarioId)
    );
}

function toRunSelection(run: TwoAgentRun): ScenarioSelectionInput {
    return { group: run.group, senderConnection: run.sender.connection, receiverConnection: run.receiver.connection };
}

/** Only the roles decide the selection, so a placeholder group and connections plan a cell before its agents open. */
function toPlanningSelection(): ScenarioSelectionInput {
    return {
        group: { applicationId: config.applicationId, workspaceId: config.workspaceId, groupId: config.roomId },
        senderConnection: 'planning-sender',
        receiverConnection: 'planning-receiver'
    };
}

/** A cell records its regime whether it passed or failed, and never fails the cell for doing so. */
async function recordObservation(
    cell: ObservationCell
): Promise<void> {
    try {
        const snapshot = await cell.run.readSnapshot();
        const pageDiagnosticsFile = toRunPageDiagnosticsFile(cell.run, snapshot);
        const regime = toObservationRegime({
            snapshot,
            carrier: cell.carrier,
            cellOutcome: cell.cellOutcome,
            pageDiagnosticsFile: toDecodedPageDiagnosticsFile(pageDiagnosticsFile)
        });
        await writeObservationFiles({
            testInfo: cell.testInfo,
            carrier: cell.carrier,
            regime,
            snapshot,
            pageDiagnosticsFile
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
    input: Readonly<{
        snapshot: ControlRunSnapshot;
        carrier: AlmConformanceCarrier;
        cellOutcome: ALMObservationCellOutcome;
        pageDiagnosticsFile: ALMObservationPageDiagnosticsFile | undefined;
    }>
): ALMObservationRegime {
    const { carrier, cellOutcome, pageDiagnosticsFile } = input;
    return decodeALMObservationSnapshot(input.snapshot).fold(
        (snapshotIssues) =>
            createUnreadableALMObservationRegime({ carrier, scope, cellOutcome, snapshotIssues, pageDiagnosticsFile }),
        (decoded) =>
            computeALMObservationRegime({ snapshot: decoded, carrier, scope, cellOutcome, pageDiagnosticsFile })
    );
}

/** `undefined` only for a run whose participants never opened a real page (never happens on this lane). */
function toRunPageDiagnosticsFile(
    run: TwoAgentRun,
    snapshot: ControlRunSnapshot
): PageDiagnosticsFile | undefined {
    const captures = [run.sender.diagnostics, run.receiver.diagnostics].filter(isPresentCapture);
    return captures.length === 0
        ? undefined
        : toPageDiagnosticsFile(captures, toPageDiagnosticsReferenceEpochMs(snapshot, captures));
}

/** The cell's first control event when the snapshot decoded, else the earliest page's own creation. */
function toPageDiagnosticsReferenceEpochMs(
    snapshot: ControlRunSnapshot,
    captures: readonly PageDiagnosticsCapture[]
): number {
    return decodeALMObservationSnapshot(snapshot).fold(
        () => Math.min(...captures.map((capture) => capture.pageCreatedAtEpochMs)),
        (decoded) => decoded.firstEventAtEpochMs
    );
}

function isPresentCapture(
    value: PageDiagnosticsCapture | undefined
): value is PageDiagnosticsCapture {
    return value !== undefined;
}

/** Decodes the file the lane is about to write, so the cell JSON reads it through the same contract a later re-read would. */
function toDecodedPageDiagnosticsFile(
    raw: PageDiagnosticsFile | undefined
): ALMObservationPageDiagnosticsFile | undefined {
    return raw === undefined
        ? undefined
        : decodeALMObservationPageDiagnosticsFile(raw).fold(() => undefined, (decoded) => decoded);
}

async function writeObservationFiles(
    observation: ObservationFiles
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
    if (observation.pageDiagnosticsFile !== undefined) {
        await writeFile(
            path.join(directory, `${fileName}-page-diagnostics.json`),
            toJsonText(observation.pageDiagnosticsFile),
            'utf8'
        );
    }
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

function toJsonText(value: ALMObservationRegime | ControlRunSnapshot | PageDiagnosticsFile): string {
    return JSON.stringify(value, null, 2);
}

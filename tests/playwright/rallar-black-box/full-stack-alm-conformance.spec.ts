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
import type {
    AlmConformanceLaneFamily,
    CreateAlmConformanceRecipesInput
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import {
    decodeALMObservationPageDiagnosticsFile,
    type ALMObservationPageDiagnosticsFile
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-page-diagnostics.ts';
import { decodeALMObservationSnapshot } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts';
import { toAlmReloadCheckpoints } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import { assessAlmConformanceIdentity } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-conformance-identity.ts';
import { readAlmReceiptRolesEntries } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-receipt-role-identity.ts';
import {
    computeALMObservationRegime,
    createUnreadableALMObservationRegime,
    toALMObservationRegimeSummary,
    type ALMObservationCellOutcome,
    type ALMObservationRegime
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-regime.ts';
import {
    createAlmConformanceRecipes,
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
import { openSuccessorPage, runRecipeTrioOnSameContext } from './full-stack-same-context-run.ts';
import {
    createThreeAgentRun,
    runRecipeTrioOnThreeAgents,
    type ThirdAgentRole,
    type ThreeAgentRun
} from './full-stack-three-agent-run.ts';
import type { PageDiagnosticsCapture } from './start-page-diagnostics-capture.ts';
import { toPageDiagnosticsFile, type PageDiagnosticsFile } from './to-page-diagnostics-file.ts';

type TwoAgentScenarioFamily = Exclude<AlmConformanceLaneFamily, 'three-agent' | 'same-context' | 'same-principal'>;

type ThreeAgentScenarioFamily = Extract<AlmConformanceLaneFamily, 'three-agent' | 'same-principal'>;

/** The role of each three-agent family's third agent, the one it adds to the sender and the receiver. */
const THIRD_AGENT_ROLES: Readonly<Record<ThreeAgentScenarioFamily, ThirdAgentRole>> = {
    'three-agent': 'recipient-b',
    'same-principal': 'sibling'
};

interface ObservationCell {
    readonly run: TwoAgentRun;
    readonly family: AlmConformanceLaneFamily;
    /** Every page of the run, whose captured page diagnostics the cell records. */
    readonly participants: readonly TwoAgentRunParticipant[];
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
    readonly fileName: string;
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
// Finite carrier ceiling covers the conformance recipes and connection readiness. With the fairness cells the full
// scope's two-agent family measured ws 5.3, rtc 6.4 and rtc-with-ws-fallback 6.8 minutes. Before the agent page paced
// its React updates, the rtc family took 15.1 minutes (about 906 s, past this ceiling): the ceiling holds only while
// the page's renders stay off the lane's sends.
const CARRIER_TEST_TIMEOUT_MS = 900_000;

/**
 * Playwright clears the output root once at the start of a run and deletes each passing test's own
 * output directory at the end, so a green cell's evidence only survives beside those directories,
 * not inside one. The observation job uploads the whole root, which carries this directory with it.
 */
const OBSERVATION_DIRECTORY_NAME = 'alm-observation';

test.describe('ALM conformance lane', () => {
    test.skip(!config.enabled, 'RALLAR_BLACK_BOX_FULL_STACK is not set');

    for (const carrier of carriers) {
        for (const family of ['two-agent', 'addressed'] as const) {
            const title = family === 'two-agent' ? 'baseline' : family;
            test(`${title} family over ${carrier} (${scope})`, async ({ browser, request }, testInfo) => {
                test.skip(
                    family === 'addressed' && selectScenarios(toPlanningSelection(), carrier, family).length === 0,
                    `no ${scope} addressed ALM scenario runs over ${carrier}`
                );
                test.setTimeout(CARRIER_TEST_TIMEOUT_MS);

                const run = await createTwoAgentRun({
                    browser,
                    request,
                    testInfo,
                    runId: family === 'two-agent'
                        ? `alm-${carrier}-${uniqueSuffix()}`
                        : `alm-${carrier}-${family}-${uniqueSuffix()}`
                });

                let scenarioFailed = false;
                try {
                    await runAlmConformanceScenarios(run, carrier, family);
                }
                catch (scenarioError) {
                    scenarioFailed = true;
                    throw scenarioError;
                }
                finally {
                    await recordObservation({
                        run,
                        family,
                        participants: [run.sender, run.receiver],
                        testInfo,
                        carrier,
                        cellOutcome: toCellOutcome(testInfo, scenarioFailed)
                    });
                    await run.close();
                }
            });
        }

        for (const family of ['three-agent', 'same-principal'] as const) {
            test(`${family} family over ${carrier} (${scope})`, async ({ browser, request }, testInfo) => {
                test.skip(
                    selectScenarios(toPlanningSelection(), carrier, family).length === 0,
                    `no ${scope} ALM scenario over ${carrier} declares the ${THIRD_AGENT_ROLES[family]} role`
                );
                test.setTimeout(CARRIER_TEST_TIMEOUT_MS);

                const run = await createThreeAgentRun({
                    browser,
                    request,
                    testInfo,
                    runId: `alm-${carrier}-${family}-${uniqueSuffix()}`,
                    thirdRole: THIRD_AGENT_ROLES[family]
                });
                let scenarioFailed = false;
                try {
                    await runThreeAgentScenarios(run, carrier, family);
                }
                catch (scenarioError) {
                    scenarioFailed = true;
                    throw scenarioError;
                }
                finally {
                    await recordObservation({
                        run,
                        family,
                        participants: [run.sender, run.receiver, run.third],
                        testInfo,
                        carrier,
                        cellOutcome: toCellOutcome(testInfo, scenarioFailed)
                    });
                    await run.close();
                }
            });
        }

        test(`same-context family over ${carrier} (${scope})`, async ({ browser, request }, testInfo) => {
            test.skip(
                selectScenarios(toPlanningSelection(), carrier, 'same-context').length === 0,
                `no ${scope} ALM scenario over ${carrier} runs on two pages of one context`
            );
            test.setTimeout(CARRIER_TEST_TIMEOUT_MS);

            const run = await createTwoAgentRun({
                browser,
                request,
                testInfo,
                runId: `alm-${carrier}-same-context-${uniqueSuffix()}`
            });
            const participants: TwoAgentRunParticipant[] = [run.sender, run.receiver];
            let scenarioFailed = false;
            try {
                await runSameContextScenarios({ run, carrier, testInfo, participants });
            }
            catch (scenarioError) {
                scenarioFailed = true;
                throw scenarioError;
            }
            finally {
                await recordObservation({
                    run,
                    family: 'same-context',
                    participants,
                    testInfo,
                    carrier,
                    cellOutcome: toCellOutcome(testInfo, scenarioFailed)
                });
                await run.close();
            }
        });
    }
});

/** Soft assertions so one run exercises every in-scope scenario and reports all of them. */
async function runAlmConformanceScenarios(
    run: TwoAgentRun,
    carrier: AlmConformanceCarrier,
    family: TwoAgentScenarioFamily
): Promise<void> {
    for (const scenario of selectScenarios(toRunSelection(run), carrier, family)) {
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
        const reload = toAlmReloadCheckpoints(scenario.sender.metadata?.almReloadCheckpoints) !== undefined;
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
    carrier: AlmConformanceCarrier,
    family: ThreeAgentScenarioFamily
): Promise<void> {
    const thirdRole = THIRD_AGENT_ROLES[family];
    for (const scenario of selectScenarios(toRunSelection(run), carrier, family)) {
        const third = toAlmConformanceRoleRecipe(scenario, thirdRole);
        if (third === undefined) {
            throw new Error(`${scenario.scenarioKey} declares three roles without a ${thirdRole} recipe.`);
        }
        const outcome = await runRecipeTrioOnThreeAgents(run, {
            sender: scenario.sender,
            receiver: scenario.receiver,
            third
        });
        for (const role of ['receiver', 'third', 'sender'] as const) {
            const name = role === 'third' ? thirdRole : role;
            expect.soft(outcome[role].ok, `${scenario.scenarioKey} ${name}: ${outcome[role].summary}`).toBe(true);
        }
        if (hasIdentityEvidence(scenario)) {
            await assertScenarioIdentity(run, scenario, [
                { role: 'sender', agent: run.sender, outcome: outcome.sender },
                { role: 'receiver', agent: run.receiver, outcome: outcome.receiver },
                { role: thirdRole, agent: run.third, outcome: outcome.third }
            ]);
        }
    }
}

interface SameContextCell {
    readonly run: TwoAgentRun;
    readonly carrier: AlmConformanceCarrier;
    readonly testInfo: TestInfo;
    /** The cell's pages; each scenario's successor joins them, so the observation reads every page that ran. */
    readonly participants: TwoAgentRunParticipant[];
}

/**
 * Each scenario ends the page that owns the sender's session, so its successor owns the session for the next one.
 * `flush-on-hide` ends it through its lifecycle flush and a crash; every other scenario closes it.
 */
async function runSameContextScenarios(cell: SameContextCell): Promise<void> {
    const { run, carrier, testInfo, participants } = cell;
    let owner = run.sender;
    for (const scenario of selectScenarios(toRunSelection(run), carrier, 'same-context')) {
        if (scenario.successor === undefined) {
            throw new Error(`${scenario.scenarioKey} runs on one context without a successor recipe.`);
        }
        const successor = await openSuccessorPage({ testInfo, run, owner });
        participants.push(successor);
        const ownerEnd = scenario.scenarioId === 'flush-on-hide' ? 'flush-and-crash' : 'close';
        const outcome = await runRecipeTrioOnSameContext(run, { owner, successor, ownerEnd }, {
            ...scenario,
            successor: scenario.successor
        });
        for (const role of ['receiver', 'sender', 'successor'] as const) {
            expect.soft(outcome[role].ok, `${scenario.scenarioKey} ${role}: ${outcome[role].summary}`).toBe(true);
        }
        owner = successor;
    }
}

/** Lifecycle and reload join message identities; a scenario that pins its receipt's roles joins recipient sessions. */
function hasIdentityEvidence(scenario: AlmConformanceScenario): boolean {
    return scenario.scenarioId === 'delivery-lifecycle' ||
        scenario.scenarioId === 'delivery-reload' ||
        readAlmReceiptRolesEntries(scenario.sender).length > 0;
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

function selectScenarios(
    selection: ScenarioSelectionInput,
    carrier: AlmConformanceCarrier,
    family: AlmConformanceLaneFamily
): readonly AlmConformanceScenario[] {
    return createAlmConformanceRecipes({
        ...selection,
        carrier,
        typeId: CONFORMANCE_TYPE_ID,
        deadlineMs: CONFORMANCE_DEADLINE_MS,
        recoveryOwner: 'record'
    }).filter((scenario) =>
        scenario.laneFamily === family &&
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
        const pageDiagnosticsFile = toRunPageDiagnosticsFile(cell.participants, snapshot);
        const regime = toObservationRegime({
            snapshot,
            carrier: cell.carrier,
            cellOutcome: cell.cellOutcome,
            pageDiagnosticsFile: toDecodedPageDiagnosticsFile(pageDiagnosticsFile)
        });
        const fileName = toObservationFileName(cell.carrier, cell.family, cell.testInfo.retry);
        await writeObservationFiles({
            testInfo: cell.testInfo,
            fileName,
            regime,
            snapshot,
            pageDiagnosticsFile
        });
        if (cell.cellOutcome === 'failed') {
            await attachRunSnapshot(snapshot, cell.testInfo, `alm-${fileName}.json`);
        }
        const summary = toALMObservationRegimeSummary(regime);
        console.info(cell.family === 'two-agent' ? summary : `${summary} family=${cell.family}`);
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
    participants: readonly TwoAgentRunParticipant[],
    snapshot: ControlRunSnapshot
): PageDiagnosticsFile | undefined {
    const captures = participants.map((participant) => participant.diagnostics).filter(isPresentCapture);
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
    const { fileName } = observation;
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

/**
 * An unsuffixed name would let a retried cell overwrite the regime and snapshot of the first attempt, or the
 * three-agent cell overwrite the two-agent one.
 */
function toObservationFileName(
    carrier: AlmConformanceCarrier,
    family: AlmConformanceLaneFamily,
    retry: number
): string {
    const cell = family === 'two-agent' ? `${carrier}-${scope}` : `${carrier}-${scope}-${family}`;
    return retry === 0 ? cell : `${cell}-retry${retry}`;
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

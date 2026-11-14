import {
    expect,
    test,
    type Frame,
    type TestInfo
} from '@playwright/test';
import { randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';

import {
    ALM_CONFORMANCE_CARRIERS,
    type AlmConformanceCarrier
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    ALM_CONFORMANCE_FOUR_ROLE_ROLES,
    ALM_CONFORMANCE_ROLES,
    ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES,
    ALM_CONFORMANCE_THREE_AGENT_ROLES,
    type AlmConformanceRole
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import {
    ALM_CONFORMANCE_LANE_FAMILIES,
    type AlmConformanceLaneFamily,
    type CreateAlmConformanceRecipesInput
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { toAlmReloadCheckpoints } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import {
    createAlmConformanceRecipes,
    toAlmConformanceRoleRecipe,
    type AlmConformanceScenario
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import {
    assessAlmConformanceIdentity,
    hasAlmIdentityEvidence,
    type AlmConformanceIdentityParticipant
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/identity/assess-alm-conformance-identity.ts';
import {
    decodeAlmLaneParameters,
    type AlmLaneParameters
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/lane/decode-alm-lane-parameters.ts';
import {
    resolveAlmLanePlan,
    toAlmLaneCellGroup,
    type AlmLaneCellOrderRecord,
    type AlmLanePlan,
    type AlmLanePlannedCell
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/lane/resolve-alm-lane-plan.ts';
import { toAlmLaneEmptyPlanReason } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/lane/to-alm-lane-empty-plan-reason.ts';
import {
    decodeALMObservationPageDiagnosticsFile,
    type ALMObservationPageDiagnosticsFile
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/observation/alm-observation-page-diagnostics.ts';
import { decodeALMObservationSnapshot } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/observation/alm-observation-snapshot.ts';
import {
    computeALMObservationRegime,
    createUnreadableALMObservationRegime,
    toALMObservationRegimeSummary,
    type ALMObservationCellOutcome,
    type ALMObservationRegime
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/observation/compute-alm-observation-regime.ts';
import {
    assessSubscriptionRevokeDisconnected,
    toAlmUnconfirmedReceiptRole
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/scenarios/topic-subscription/assess-subscription-revoke-disconnected.ts';
import { parseControlClientMessage } from '../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestRecipe } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    closeAgentConnections,
    createAgentRun,
    runRecipesOnAgents,
    toAgentRunPrincipalIds,
    type AgentRecipeRun,
    type AgentRun
} from './full-stack-agent-run.ts';
import { startCellGateRun } from './full-stack-cell-gate-run.ts';
import {
    createTwoAgentRun,
    readFullStackConfig,
    runRecipePairOnTwoAgents,
    uniqueSuffix,
    type RecipePairOutcome,
    type RecipeRunOutcome,
    type TwoAgentRun,
    type TwoAgentRunParticipant
} from './full-stack-helpers.ts';
import { openSuccessorPage, runRecipeTrioOnSameContext } from './full-stack-same-context-run.ts';
import type { PageDiagnosticsCapture } from './start-page-diagnostics-capture.ts';
import { toPageDiagnosticsFile, type PageDiagnosticsFile } from './to-page-diagnostics-file.ts';

type TwoAgentScenarioFamily = Extract<AlmConformanceLaneFamily, 'two-agent' | 'addressed'>;

type AgentScenarioFamily = Extract<AlmConformanceLaneFamily, 'three-agent' | 'same-principal' | 'four-role'>;

interface ObservationCell {
    readonly run: TwoAgentRun;
    readonly family: AlmConformanceLaneFamily;
    /** Every page of the run, whose captured page diagnostics the cell records. */
    readonly participants: readonly TwoAgentRunParticipant[];
    readonly testInfo: TestInfo;
    readonly carrier: AlmConformanceCarrier;
    readonly cellOutcome: ALMObservationCellOutcome;
    readonly cellOrder: AlmLaneCellOrderRecord;
}

interface PlannedScenario {
    readonly cell: AlmLanePlannedCell;
    readonly scenario: AlmConformanceScenario;
}

interface ScenarioRoleEvidence {
    readonly role: AlmConformanceRole;
    readonly agent: TwoAgentRunParticipant;
    readonly outcome: RecipeRunOutcome;
}

interface ScenarioSelectionInput
    extends
        Pick<
            CreateAlmConformanceRecipesInput,
            'group' | 'senderConnection' | 'receiverConnection' | 'principalIdsByRole'
        > {}

interface ObservationRegimeInput {
    readonly snapshot: ControlRunSnapshot;
    readonly carrier: AlmConformanceCarrier;
    readonly cellOutcome: ALMObservationCellOutcome;
    readonly cellOrder: AlmLaneCellOrderRecord;
    readonly pageDiagnosticsFile: ALMObservationPageDiagnosticsFile | undefined;
}

interface ObservationFiles {
    readonly testInfo: TestInfo;
    readonly fileName: string;
    readonly regime: ALMObservationRegime;
    readonly snapshot: ControlRunSnapshot;
    readonly pageDiagnosticsFile: PageDiagnosticsFile;
}

interface SameContextCell {
    readonly run: TwoAgentRun;
    readonly carrier: AlmConformanceCarrier;
    readonly plan: AlmLanePlan;
    readonly testInfo: TestInfo;
    /** The cell's pages; each scenario's successor joins them, so the observation reads every page that ran. */
    readonly participants: TwoAgentRunParticipant[];
}

/** The roles of each family that runs on an agent per role; each scenario of the family declares exactly these. */
const AGENT_FAMILY_ROLES: Readonly<Record<AgentScenarioFamily, readonly AlmConformanceRole[]>> = {
    'three-agent': ALM_CONFORMANCE_THREE_AGENT_ROLES,
    'same-principal': ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES,
    'four-role': ALM_CONFORMANCE_FOUR_ROLE_ROLES
};

const config = readFullStackConfig();
const scope = process.env.RALLAR_BLACK_BOX_ALM_SCOPE === 'full' ? 'full' : 'smoke';
const carriers = toCarrierSelection(process.env.RALLAR_BLACK_BOX_ALM_CARRIERS);

const CONFORMANCE_TYPE_ID = 'alm.conformance';
const CONFORMANCE_DEADLINE_MS = 18_000;
const laneParameters = config.enabled ? readLaneParameters() : undefined;
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
                    planFamily(carrier, family).cells.length === 0,
                    toEmptyPlanReason(carrier, family, `no ${scope} ${title} ALM scenario runs over ${carrier}`)
                );
                test.setTimeout(CARRIER_TEST_TIMEOUT_MS);
                const plan = announcePlan(carrier, family);

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
                    await startCellGateRun({
                        run,
                        cellKey: undefined,
                        agentsByRole: new Map([['sender', run.sender], ['receiver', run.receiver]])
                    });
                    await runAlmConformanceScenarios(run, carrier, family, plan);
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
                        cellOutcome: toCellOutcome(testInfo, scenarioFailed),
                        cellOrder: plan.cellOrder
                    });
                    await run.close();
                }
            });
        }

        for (const family of ['three-agent', 'same-principal', 'four-role'] as const) {
            test(`${family} family over ${carrier} (${scope})`, async ({ browser, request }, testInfo) => {
                test.skip(
                    planFamily(carrier, family).cells.length === 0,
                    toEmptyPlanReason(
                        carrier,
                        family,
                        `no ${scope} ALM scenario over ${carrier} declares the ${
                            AGENT_FAMILY_ROLES[family].join(', ')
                        } roles`
                    )
                );
                test.setTimeout(CARRIER_TEST_TIMEOUT_MS);
                const plan = announcePlan(carrier, family);

                const run = await createAgentRun({
                    browser,
                    request,
                    testInfo,
                    runId: `alm-${carrier}-${family}-${uniqueSuffix()}`,
                    roles: AGENT_FAMILY_ROLES[family]
                });
                let scenarioFailed = false;
                try {
                    await startCellGateRun({ run, cellKey: undefined, agentsByRole: run.agents });
                    await runAgentScenarios(run, carrier, family, plan);
                }
                catch (scenarioError) {
                    scenarioFailed = true;
                    throw scenarioError;
                }
                finally {
                    await recordObservation({
                        run,
                        family,
                        participants: [...run.agents.values()],
                        testInfo,
                        carrier,
                        cellOutcome: toCellOutcome(testInfo, scenarioFailed),
                        cellOrder: plan.cellOrder
                    });
                    await run.close();
                }
            });
        }

        test(`same-context family over ${carrier} (${scope})`, async ({ browser, request }, testInfo) => {
            test.skip(
                planFamily(carrier, 'same-context').cells.length === 0,
                toEmptyPlanReason(
                    carrier,
                    'same-context',
                    `no ${scope} ALM scenario over ${carrier} runs on two pages of one context`
                )
            );
            test.setTimeout(CARRIER_TEST_TIMEOUT_MS);
            const plan = announcePlan(carrier, 'same-context');

            const run = await createTwoAgentRun({
                browser,
                request,
                testInfo,
                runId: `alm-${carrier}-same-context-${uniqueSuffix()}`
            });
            const participants: TwoAgentRunParticipant[] = [run.sender, run.receiver];
            let scenarioFailed = false;
            try {
                await runSameContextScenarios({ run, carrier, plan, testInfo, participants });
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
                    cellOutcome: toCellOutcome(testInfo, scenarioFailed),
                    cellOrder: plan.cellOrder
                });
                await run.close();
            }
        });
    }
});

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
    return ALM_CONFORMANCE_CARRIERS.some((carrier) => carrier === value);
}

function createFamilyScenarios(
    selection: ScenarioSelectionInput,
    carrier: AlmConformanceCarrier,
    family: AlmConformanceLaneFamily
): readonly AlmConformanceScenario[] {
    return createAlmConformanceRecipes({
        ...selection,
        carrier,
        typeId: CONFORMANCE_TYPE_ID,
        deadlineMs: CONFORMANCE_DEADLINE_MS,
        laneFamilies: [family],
        recoveryOwner: 'record',
        cellSettle: 'barriered'
    });
}

/**
 * An unknown value of any lane parameter, or a named cell this selection cannot run, is refused when the spec loads,
 * before any browser starts.
 */
function readLaneParameters(): AlmLaneParameters {
    const catalog = ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
        ALM_CONFORMANCE_LANE_FAMILIES.flatMap((family) =>
            createFamilyScenarios(toPlanningSelection(), carrier, family)
                .map(({ scenarioId, scenarioKey, tags }) => ({ carrier, scenarioId, scenarioKey, tags }))
        )
    );
    const values = {
        order: process.env.RALLAR_BLACK_BOX_ALM_ORDER,
        seed: process.env.RALLAR_BLACK_BOX_ALM_SEED,
        rooms: process.env.RALLAR_BLACK_BOX_ALM_ROOMS,
        only: process.env.RALLAR_BLACK_BOX_ALM_ONLY,
        skip: process.env.RALLAR_BLACK_BOX_ALM_SKIP
    };
    return decodeAlmLaneParameters({ values, catalog, selection: { scope, carriers } }).fold(
        (issues) => {
            throw new RangeError(`The ALM lane parameters are refused: ${issues.join(' ')}`);
        },
        (parameters) => parameters
    );
}

/** Only an enabled lane decodes its parameters, so no other full-stack run reads them. */
function requireLaneParameters(): AlmLaneParameters {
    if (laneParameters === undefined) {
        throw new Error('The ALM conformance lane plans no cell while RALLAR_BLACK_BOX_FULL_STACK is not set.');
    }
    return laneParameters;
}

/** A shuffled family that names no seed mints one, which the lane prints before the family's first cell. */
function planFamily(carrier: AlmConformanceCarrier, family: AlmConformanceLaneFamily): AlmLanePlan {
    return resolveAlmLanePlan({
        family,
        carrier,
        scenarios: createFamilyScenarios(toPlanningSelection(), carrier, family),
        scope,
        parameters: requireLaneParameters(),
        mintSeed: () => randomInt(0, 2 ** 31)
    });
}

function toEmptyPlanReason(
    carrier: AlmConformanceCarrier,
    family: AlmConformanceLaneFamily,
    otherwise: string
): string {
    return toAlmLaneEmptyPlanReason({ only: requireLaneParameters().only, family, carrier, otherwise });
}

/** Printed before the first cell, so a run that dies mid-way can be replayed with the same seed. */
function announcePlan(carrier: AlmConformanceCarrier, family: AlmConformanceLaneFamily): AlmLanePlan {
    const plan = planFamily(carrier, family);
    const { mode, seed, rooms, scenarioKeys } = plan.cellOrder;
    console.info(
        `ALM lane plan ${carrier}-${scope} family=${family}: order=${mode} seed=${seed ?? 'none'} rooms=${rooms} ` +
            `cells=${scenarioKeys.join(',')}`
    );
    return plan;
}

/**
 * Each planned cell with its scenario for the run's agents. The family's room is created once for the run; a cell of
 * its own room is created in that room.
 */
function toPlannedScenarios(
    run: TwoAgentRun | AgentRun,
    carrier: AlmConformanceCarrier,
    planned: Readonly<{ family: AlmConformanceLaneFamily; plan: AlmLanePlan; }>
): readonly PlannedScenario[] {
    const selection = toRunSelection(run);
    const familyRoom = planned.plan.cells.some((cell) => cell.room === 'family')
        ? createFamilyScenarios(selection, carrier, planned.family)
        : [];
    return planned.plan.cells.map((cell) => {
        const created = cell.room === 'family'
            ? familyRoom
            : createFamilyScenarios(
                { ...selection, group: toAlmLaneCellGroup(selection.group, cell) },
                carrier,
                planned.family
            );
        const scenario = created.find((candidate) => candidate.scenarioKey === cell.scenarioKey);
        if (scenario === undefined) {
            throw new Error(`${cell.scenarioKey} is planned but not created over ${carrier}.`);
        }
        return { cell, scenario };
    });
}

/** A same-context successor is the sender's own principal on a second page of its context. */
function toRunSelection(run: TwoAgentRun | AgentRun): ScenarioSelectionInput {
    return {
        group: run.group,
        senderConnection: run.sender.connection,
        receiverConnection: run.receiver.connection,
        principalIdsByRole: 'agents' in run ? toAgentRunPrincipalIds(run) : {
            sender: run.sender.principalId,
            successor: run.sender.principalId,
            receiver: run.receiver.principalId
        }
    };
}

/** Only the roles decide the selection, so a placeholder group, connections and principals plan a cell before its agents open. */
function toPlanningSelection(): ScenarioSelectionInput {
    return {
        group: { applicationId: config.applicationId, workspaceId: config.workspaceId, groupId: config.roomId },
        senderConnection: 'planning-sender',
        receiverConnection: 'planning-receiver',
        principalIdsByRole: Object.fromEntries(ALM_CONFORMANCE_ROLES.map((role) => [role, `planning-${role}`]))
    };
}

function toObservationRegime(
    input: ObservationRegimeInput
): ALMObservationRegime {
    const { carrier, cellOutcome, cellOrder, pageDiagnosticsFile } = input;
    return decodeALMObservationSnapshot(input.snapshot).fold(
        (snapshotIssues) =>
            createUnreadableALMObservationRegime({
                carrier,
                scope,
                cellOutcome,
                cellOrder,
                snapshotIssues,
                pageDiagnosticsFile
            }),
        (decoded) =>
            computeALMObservationRegime({
                snapshot: decoded,
                carrier,
                scope,
                cellOutcome,
                cellOrder,
                pageDiagnosticsFile
            })
    );
}

/** Every completed participant owns the capture attached when its real page was created. */
function toRunPageDiagnosticsFile(
    participants: readonly TwoAgentRunParticipant[],
    snapshot: ControlRunSnapshot
): PageDiagnosticsFile {
    const captures = participants.map((participant) => participant.diagnostics);
    if (captures.length === 0) {
        throw new Error('A completed ALM run must retain participant diagnostics.');
    }
    return toPageDiagnosticsFile(captures, toPageDiagnosticsReferenceEpochMs(snapshot, captures));
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

/** Decodes the file the lane is about to write, so the cell JSON reads it through the same contract a later re-read would. */
function toDecodedPageDiagnosticsFile(
    raw: PageDiagnosticsFile
): ALMObservationPageDiagnosticsFile | undefined {
    return decodeALMObservationPageDiagnosticsFile(raw).fold(() => undefined, (decoded) => decoded);
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

/** Soft assertions record their failures on `testInfo` the moment they fire, before the cell ends. */
function toCellOutcome(testInfo: TestInfo, scenarioFailed: boolean): ALMObservationCellOutcome {
    return scenarioFailed || testInfo.errors.length > 0 ? 'failed' : 'passed';
}

function toJsonText(value: ALMObservationRegime | ControlRunSnapshot | PageDiagnosticsFile): string {
    return JSON.stringify(value, null, 2);
}

/** Soft assertions so one run exercises every planned scenario and reports all of them. */
async function runAlmConformanceScenarios(
    run: TwoAgentRun,
    carrier: AlmConformanceCarrier,
    family: TwoAgentScenarioFamily,
    plan: AlmLanePlan
): Promise<void> {
    for (const { cell, scenario } of toPlannedScenarios(run, carrier, { family, plan })) {
        await runPairCell(run, scenario);
        if (cell.closeConnectionsAfter) {
            await closeAgentConnections(toPairAgentRun(run), cell.scenarioKey);
        }
    }
}

async function runPairCell(run: TwoAgentRun, scenario: AlmConformanceScenario): Promise<void> {
    const outcome = await runPairWatchingReloads(run, scenario);
    expect.soft(outcome.receiver.ok, `${scenario.scenarioKey} receiver: ${outcome.receiver.summary}`)
        .toBe(true);
    expect.soft(outcome.sender.ok, `${scenario.scenarioKey} sender: ${outcome.sender.summary}`)
        .toBe(true);
    if (hasAlmIdentityEvidence(scenario.sender)) {
        await assertScenarioIdentity(run, scenario, [
            { role: 'sender', agent: run.sender, outcome: outcome.sender },
            { role: 'receiver', agent: run.receiver, outcome: outcome.receiver }
        ]);
    }
}

/** A reload cell replaces the sender's main-frame document once and leaves the receiver's. */
async function runPairWatchingReloads(run: TwoAgentRun, scenario: AlmConformanceScenario): Promise<RecipePairOutcome> {
    if (toAlmReloadCheckpoints(scenario.sender.metadata?.almReloadCheckpoints) === undefined) {
        return await runRecipePairOnTwoAgents(run, scenario);
    }
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
    run.sender.page.on('framenavigated', onSenderNavigation);
    run.receiver.page.on('framenavigated', onReceiverNavigation);
    let outcome: RecipePairOutcome;
    try {
        outcome = await runRecipePairOnTwoAgents(run, scenario);
    }
    finally {
        run.sender.page.off('framenavigated', onSenderNavigation);
        run.receiver.page.off('framenavigated', onReceiverNavigation);
    }
    expect.soft(senderNavigations, 'reload replaces the actual sender main-frame document once').toBe(1);
    expect.soft(receiverNavigations, 'receiver retains its document and subscriptions').toBe(0);
    return outcome;
}

/** The pair's two agents by role, so a room of its own per cell closes their connections as any family's. */
function toPairAgentRun(run: TwoAgentRun): AgentRecipeRun {
    return { ...run, agents: new Map([['sender', run.sender], ['receiver', run.receiver]]) };
}

async function runAgentScenarios(
    run: AgentRun,
    carrier: AlmConformanceCarrier,
    family: AgentScenarioFamily,
    plan: AlmLanePlan
): Promise<void> {
    for (const { cell, scenario } of toPlannedScenarios(run, carrier, { family, plan })) {
        const recipes = new Map(scenario.roles.map((role) => [role, requireRoleRecipe(scenario, role)] as const));
        const outcomes = await runRecipesOnAgents(run, recipes, scenario.continuation);
        const evidence = scenario.roles.map((role) => ({
            role,
            agent: requireRoleAgent(run, role),
            outcome: requireRoleOutcome(outcomes.roles, role)
        }));
        for (const { role, outcome } of evidence) {
            expect.soft(outcome.ok, `${scenario.scenarioKey} ${role}: ${outcome.summary}`).toBe(true);
        }
        if (outcomes.continuation !== undefined) {
            expect.soft(
                outcomes.continuation.ok,
                `${scenario.scenarioKey} ${scenario.continuation?.role} continuation: ${outcomes.continuation.summary}`
            )
                .toBe(true);
        }
        await assertScenarioEvidence(run, scenario, evidence);
        if (cell.closeConnectionsAfter) {
            await closeAgentConnections(run, cell.scenarioKey);
        }
    }
}

/** The identity rules and the unconfirmed-role receipt check, each selected by the sender recipe's metadata. */
async function assertScenarioEvidence(
    run: AgentRun,
    scenario: AlmConformanceScenario,
    evidence: readonly ScenarioRoleEvidence[]
): Promise<void> {
    if (hasAlmIdentityEvidence(scenario.sender)) {
        await assertScenarioIdentity(run, scenario, evidence);
    }
    const unconfirmedRole = toAlmUnconfirmedReceiptRole(scenario.sender);
    if (unconfirmedRole !== undefined) {
        await assertRevokedRoleUnconfirmed(run, scenario, { evidence, unconfirmedRole });
    }
}

/** No receipt of the cell may confirm the role its sender names, such as a sibling revoked while disconnected. */
async function assertRevokedRoleUnconfirmed(
    run: AgentRun,
    scenario: AlmConformanceScenario,
    unconfirmed: Readonly<{ evidence: readonly ScenarioRoleEvidence[]; unconfirmedRole: AlmConformanceRole; }>
): Promise<void> {
    const participants = toIdentityParticipants(await run.readSnapshot(), scenario, unconfirmed.evidence);
    const issues = assessSubscriptionRevokeDisconnected({
        runId: run.runId,
        sender: requireRoleParticipant(participants, 'sender'),
        sibling: requireRoleParticipant(participants, unconfirmed.unconfirmedRole)
    });
    expect.soft(issues, `${scenario.scenarioKey}: no receipt confirms the ${unconfirmed.unconfirmedRole}`).toEqual([]);
}

function requireRoleParticipant(
    participants: readonly AlmConformanceIdentityParticipant[],
    role: AlmConformanceRole
): AlmConformanceIdentityParticipant {
    const participant = participants.find((candidate) => candidate.role === role);
    if (participant === undefined) {
        throw new Error(`The run recorded no participant for ${role}.`);
    }
    return participant;
}

function requireRoleRecipe(scenario: AlmConformanceScenario, role: AlmConformanceRole): RallarBlackBoxTestRecipe {
    const recipe = toAlmConformanceRoleRecipe(scenario, role);
    if (recipe === undefined) {
        throw new Error(`${scenario.scenarioKey} declares ${role} without its recipe.`);
    }
    return recipe;
}

function requireRoleAgent(run: AgentRun, role: AlmConformanceRole): TwoAgentRunParticipant {
    const agent = run.agents.get(role);
    if (agent === undefined) {
        throw new Error(`The run opened no agent for ${role}.`);
    }
    return agent;
}

function requireRoleOutcome(
    outcomes: ReadonlyMap<AlmConformanceRole, RecipeRunOutcome>,
    role: AlmConformanceRole
): RecipeRunOutcome {
    const outcome = outcomes.get(role);
    if (outcome === undefined) {
        throw new Error(`The run reported no outcome for ${role}.`);
    }
    return outcome;
}

/**
 * Each scenario ends the page that owns the sender's session, as its definition declares, so its successor owns the
 * session for the next one. The cells follow the plan's order; each starts its own gate run, because its owner page
 * changes every cell.
 */
async function runSameContextScenarios(cell: SameContextCell): Promise<void> {
    const { run, carrier, plan, testInfo, participants } = cell;
    let owner = run.sender;
    for (const { scenario } of toPlannedScenarios(run, carrier, { family: 'same-context', plan })) {
        if (scenario.successor === undefined || scenario.ownerEnd === undefined) {
            throw new Error(`${scenario.scenarioKey} runs on one context without a successor recipe.`);
        }
        const successor = await openSuccessorPage({ testInfo, run, owner });
        participants.push(successor);
        await startCellGateRun({
            run,
            cellKey: scenario.scenarioKey,
            agentsByRole: new Map([['sender', owner], ['receiver', run.receiver]])
        });
        const successorGate = scenario.successorGate?.commandId;
        const pages = { owner, successor, ownerEnd: scenario.ownerEnd, successorGate };
        const outcome = await runRecipeTrioOnSameContext(run, pages, { ...scenario, successor: scenario.successor });
        for (const role of ['receiver', 'sender', 'successor'] as const) {
            expect.soft(outcome[role].ok, `${scenario.scenarioKey} ${role}: ${outcome[role].summary}`).toBe(true);
        }
        owner = successor;
    }
}

async function assertScenarioIdentity(
    run: TwoAgentRun,
    scenario: AlmConformanceScenario,
    evidence: readonly ScenarioRoleEvidence[]
): Promise<void> {
    const issues = assessAlmConformanceIdentity({
        runId: run.runId,
        roles: scenario.roles,
        participants: toIdentityParticipants(await run.readSnapshot(), scenario, evidence)
    });
    expect.soft(issues, 'ALM actual identity evidence for every declared role').toEqual([]);
}

/** Each declared role's recipe joined to the result envelope its run recorded in the control snapshot. */
function toIdentityParticipants(
    snapshot: ControlRunSnapshot,
    scenario: AlmConformanceScenario,
    evidence: readonly ScenarioRoleEvidence[]
): readonly AlmConformanceIdentityParticipant[] {
    return evidence.flatMap(({ role, agent, outcome }) => {
        const recipe = toAlmConformanceRoleRecipe(scenario, role);
        const recorded = snapshot.results.find((result) => result.commandId === outcome.commandId);
        const decoded = parseControlClientMessage(recorded);
        return recipe === undefined ? [] : [{
            role,
            agentId: agent.agentId,
            recipe,
            commandId: outcome.commandId,
            result: decoded.ok && decoded.envelope.kind === 'result' ? decoded.envelope : undefined
        }];
    });
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
            cellOrder: cell.cellOrder,
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
    await writeFile(
        path.join(directory, `${fileName}-page-diagnostics.json`),
        toJsonText(observation.pageDiagnosticsFile),
        'utf8'
    );
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

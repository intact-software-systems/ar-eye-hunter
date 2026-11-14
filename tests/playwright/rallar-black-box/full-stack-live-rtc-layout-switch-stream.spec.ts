import {
    expect,
    test,
    type APIRequestContext,
    type Browser,
    type TestInfo
} from '@playwright/test';

import { RALLAR_BLACK_BOX_RTC_STREAM_DEFAULT_DRAIN_TIMEOUT_MS } from '@shared-test/rallar-bb-test/rtc-stream.ts';
import {
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { toError } from '@shared/resilience/to-error.ts';

import {
    almDiagnostics,
    apiBaseUrl,
    applicationId,
    CONTROL_BASE_URL,
    hasThreeAgentConfig,
    LIVE_RTC_SKIP_MESSAGE,
    openAgentTrio,
    roomSeed,
    routineBrowserDiagnostics,
    workspaceId,
    type LiveRtcAgentTrio
} from './live-rtc-agent-environment.ts';
import { closeLiveRtcBrowserAgentContexts } from './live-rtc-browser-agents.ts';
import { LiveRtcControlClient } from './live-rtc-control-client.ts';
import { createLiveRtcDeliveryOperations, type AgentPrefix } from './live-rtc-delivery-operations.ts';
import { createLiveRtcFormationOperations } from './live-rtc-formation-operations.ts';
import {
    computeLiveRtcLayoutSwitchEvidence,
    countLiveRtcMissingFrames,
    type LiveRtcLayoutSwitchEvidence,
    type LiveRtcLayoutSwitchStream
} from './live-rtc-layout-switch-evidence.ts';
import { LiveRtcLayoutSwitchOperations, type LiveRtcStreamReliability } from './live-rtc-layout-switch-operations.ts';
import {
    resolveLiveRtcLayoutShape,
    toLiveRtcAcceptedLayout,
    type LiveRtcAcceptedLayout,
    type LiveRtcLayoutShape
} from './resolve-live-rtc-layout-shape.ts';

/**
 * Ruling 6 of the make-before-break plan, as the controller scoped it: three browsers each stream 20 frames a
 * second to the room while the owner switches the complete graph to a tree (an edge breaks) and, outside that
 * switch's overlap, back again (the edge returns). Which browser becomes the relay is unknown until the tree
 * exists, so every browser streams and every origin-receiver pair is checked. Evidence is what the browsers
 * already emit: their message events, ALM inbound diagnostics, send results, formation changes and health.
 */

const MESSAGES_RTC = { typeId: 'manual.type', topicId: 'manual.topic' } as const;
const STREAM_RATE_HZ = 20;
const STREAM_LEAD_MS = 3_000;
/** Outside the 15 s overlap of the previous switch, so the two promotions never share one overlap. */
const SWITCH_HOLD_MS = 16_000;
/** The full-stack config's expect timeout, restated: each stream is sized before it starts. */
const PROMOTION_POLL_TIMEOUT_MS = 15_000;
const STREAM_DURATION_MS = STREAM_LEAD_MS + 2 * (PROMOTION_POLL_TIMEOUT_MS + SWITCH_HOLD_MS);
/** Ruling 2: the overlap the managed API serves by default. */
const SERVED_OVERLAP_MS = 15_000;
const RELIABILITIES: readonly LiveRtcStreamReliability[] = ['at-least-once', 'best-effort'];
const REPORTED_RECORDS = 20;

const formationOperations = createLiveRtcFormationOperations();
const deliveryOperations = createLiveRtcDeliveryOperations({
    apiBaseUrl,
    applicationId,
    workspaceId,
    messagesRtcTypeId: MESSAGES_RTC.typeId,
    messagesRtcTopicId: MESSAGES_RTC.topicId,
    almDiagnostics,
    formation: formationOperations
});

interface LayoutSwitchScenario {
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly groupId: string;
    readonly suffix: string;
    readonly agents: LiveRtcAgentTrio;
    readonly operations: LiveRtcLayoutSwitchOperations;
}

type SessionIds = readonly [string, string, string];

interface ExpectedPromotion {
    readonly previous: GroupLayoutIdentity;
    readonly kind: 'tree' | 'complete';
    readonly label: string;
    readonly sessionIds: SessionIds;
}

interface ObservedPromotion {
    readonly layout: LiveRtcAcceptedLayout;
    readonly detectedAtEpochMs: number;
}

interface LayoutSwitchRun {
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly tree: Extract<LiveRtcLayoutShape, { kind: 'tree'; }>;
    /** Formed, after switch 1, after switch 2. */
    readonly layouts: readonly [LiveRtcAcceptedLayout, LiveRtcAcceptedLayout, LiveRtcAcceptedLayout];
    readonly requestedAtEpochMs: readonly [number, number];
    readonly leafToLeafReadyAtSwitch2: Readonly<Record<string, boolean>>;
    readonly evidence: LiveRtcLayoutSwitchEvidence;
}

test.describe('live RTC layout switch stream', () => {
    test.skip(!hasThreeAgentConfig, LIVE_RTC_SKIP_MESSAGE);

    for (const reliability of RELIABILITIES) {
        test(`three ${reliability} 20 Hz streams cross an owner-issued tree switch and its reversal`, async ({
            browser,
            request
        }, testInfo) => {
            test.setTimeout(360_000);
            expect(
                process.env.RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS,
                'The control server must keep every event: run with RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS=unbounded'
            ).toBe('unbounded');
            expect(almDiagnostics, 'Admission outcomes are read from the ALM inbound diagnostics').toBe(true);
            expect(routineBrowserDiagnostics, 'Formation changes and send results are routine diagnostics')
                .toBe('enabled');
            const scenario = await openScenario(browser, request);
            try {
                const run = await runLayoutSwitches(scenario, reliability);
                await attachRun(testInfo, run);
                expectLayoutSwitchPasses(run);
                await scenario.control.captureDiagnostics({
                    testInfo,
                    runId: scenario.runId,
                    agents: scenario.agents,
                    label: `layout-switch-${reliability}-${scenario.suffix}`,
                    cycle: null
                });
            }
            finally {
                await retire(scenario, testInfo);
            }
        });
    }
});

async function openScenario(browser: Browser, request: APIRequestContext): Promise<LayoutSwitchScenario> {
    const control = new LiveRtcControlClient({
        request,
        baseUrl: CONTROL_BASE_URL,
        monotonicNow: () => performance.now(),
        epochNow: () => Date.now()
    });
    const suffix = `layout-switch-${Date.now()}-${crypto.randomUUID()}`;
    const runId = `rallar-layout-switch-stream-${suffix}`;
    const groupId = `${roomSeed}-${suffix}`;
    const agents = await openAgentTrio(browser, { runId, groupId, suffix, label: 'layout-switch' });
    const operations = new LiveRtcLayoutSwitchOperations({
        control,
        formation: formationOperations,
        runId,
        roomRef: { applicationId, workspaceId, groupId },
        suffix,
        owner: agents[0],
        messagesRtc: MESSAGES_RTC
    });
    return { control, runId, groupId, suffix, agents, operations };
}

/** The matrix driver's room: managed, owner first, planned, connected and activated, over typed RTC messages. */
async function formRoom(scenario: LayoutSwitchScenario): Promise<Readonly<Record<AgentPrefix, string>>> {
    const { control, runId, agents, groupId, suffix } = scenario;
    await control.browserRecording.admit({ runId, agents, mode: routineBrowserDiagnostics });
    await deliveryOperations.setupGroupMembership({
        control,
        runId,
        owner: agents[0],
        members: agents,
        groupId,
        suffix
    });
    const formation = await deliveryOperations.runGroupFormation({
        control,
        runId,
        agents,
        transport: 'messages.rtc',
        groupId,
        suffix,
        readinessScope: 'all'
    });
    return formation.sessions;
}

/** Step 1: the formed room is the complete graph, and the managed API serves the default overlap. */
async function readFormedLayout(
    scenario: LayoutSwitchScenario,
    sessionIds: SessionIds
): Promise<LiveRtcAcceptedLayout> {
    expect(await scenario.operations.readServedOverlapMs(), 'The managed API serves the default overlap in /api/config')
        .toBe(SERVED_OVERLAP_MS);
    const formed = await readCommonLayout(scenario, 'the formed room');
    expect(
        resolveLiveRtcLayoutShape(formed, sessionIds),
        `The formed room's accepted layout is not the complete graph: ${JSON.stringify(formed)}`
    ).toEqual({ kind: 'complete' });
    return formed;
}

async function runLayoutSwitches(
    scenario: LayoutSwitchScenario,
    reliability: LiveRtcStreamReliability
): Promise<LayoutSwitchRun> {
    const sessions = await formRoom(scenario);
    const sessionIds: SessionIds = [sessions.A, sessions.B, sessions.C];
    const formed = await readFormedLayout(scenario, sessionIds);
    const streams = startStreams(scenario, reliability);
    await holdFor(scenario, STREAM_LEAD_MS);
    const switched = await runSwitches(scenario, { sessions, sessionIds, formed });
    const settledStreams = requireStreams(scenario, sessions, await streams);
    const events = await drainReceivers(scenario, settledStreams);
    return {
        ...switched,
        sessions,
        evidence: computeLiveRtcLayoutSwitchEvidence({
            runId: scenario.runId,
            streams: settledStreams,
            switches: [
                { identity: switched.layouts[1].identity, requestedAtEpochMs: switched.requestedAtEpochMs[0] },
                { identity: switched.layouts[2].identity, requestedAtEpochMs: switched.requestedAtEpochMs[1] }
            ],
            leafSessionIds: switched.tree.leafSessionIds,
            events
        })
    };
}

/** Steps 3 and 4: the break side, a hold outside its overlap, then the add side. */
async function runSwitches(
    scenario: LayoutSwitchScenario,
    room: Readonly<
        { sessions: Readonly<Record<AgentPrefix, string>>; sessionIds: SessionIds; formed: LiveRtcAcceptedLayout; }
    >
): Promise<Omit<LayoutSwitchRun, 'sessions' | 'evidence'>> {
    const { sessionIds } = room;
    const treeRequestedAt = await scenario.operations.writeTopologyKind('tree');
    const tree = await waitForPromotion(scenario, {
        previous: room.formed.identity,
        kind: 'tree',
        label: 'switch 1',
        sessionIds
    });
    const treeShape = resolveTree(tree.layout, sessionIds);
    await holdFor(scenario, tree.detectedAtEpochMs + SWITCH_HOLD_MS - Date.now());
    await expectTreeHeld(scenario, tree.layout);
    const leafToLeafReadyAtSwitch2 = await readLeafToLeafReadiness(scenario, room.sessions, treeShape);
    const starRequestedAt = await scenario.operations.writeTopologyKind('star');
    const star = await waitForPromotion(scenario, {
        previous: tree.layout.identity,
        kind: 'complete',
        label: 'switch 2',
        sessionIds
    });
    return {
        tree: treeShape,
        layouts: [room.formed, tree.layout, star.layout],
        requestedAtEpochMs: [treeRequestedAt, starRequestedAt],
        leafToLeafReadyAtSwitch2
    };
}

/** Settled, never rejected: a failure later in the scenario must not leave a stream's rejection unhandled. */
function startStreams(
    scenario: LayoutSwitchScenario,
    reliability: LiveRtcStreamReliability
): Promise<PromiseSettledResult<LiveRtcControlClient.Result>[]> {
    return Promise.allSettled(scenario.agents.map(async (agent) =>
        await scenario.operations.runStream({
            agent,
            reliability,
            rateHz: STREAM_RATE_HZ,
            durationMs: STREAM_DURATION_MS
        })
    ));
}

function requireStreams(
    scenario: LayoutSwitchScenario,
    sessions: Readonly<Record<AgentPrefix, string>>,
    settled: readonly PromiseSettledResult<LiveRtcControlClient.Result>[]
): readonly LiveRtcLayoutSwitchStream[] {
    return scenario.agents.map((agent, index) => {
        const outcome = settled[index];
        if (outcome?.status !== 'fulfilled' || !outcome.value.ok) {
            const reason = outcome?.status === 'rejected'
                ? toError(outcome.reason).message
                : JSON.stringify(outcome?.value);
            throw new Error(`Browser ${agent.prefix}'s stream did not report a result: ${reason}`);
        }
        return {
            prefix: agent.prefix,
            agentId: agent.agentId,
            sessionId: sessions[agent.prefix],
            result: scenario.control.resultValue(outcome.value)
        };
    });
}

async function readAcceptedLayouts(
    scenario: LayoutSwitchScenario
): Promise<readonly (LiveRtcAcceptedLayout | undefined)[]> {
    const layouts: (LiveRtcAcceptedLayout | undefined)[] = [];
    for (const agent of scenario.agents) {
        layouts.push(toLiveRtcAcceptedLayout((await scenario.operations.readHealth(agent)).formation));
    }
    return layouts;
}

/** Every browser holds one accepted layout, the same identity with the same adjacency. */
async function readCommonLayout(scenario: LayoutSwitchScenario, label: string): Promise<LiveRtcAcceptedLayout> {
    const layouts = await readAcceptedLayouts(scenario);
    const common = toCommonLayout(layouts);
    if (common === undefined) {
        throw new Error(`The browsers do not hold one accepted layout at ${label}: ${JSON.stringify(layouts)}`);
    }
    return common;
}

function toCommonLayout(layouts: readonly (LiveRtcAcceptedLayout | undefined)[]): LiveRtcAcceptedLayout | undefined {
    const [first] = layouts;
    return first !== undefined && layouts.every((layout) => layout !== undefined && isSameLayout(layout, first))
        ? first
        : undefined;
}

function isSameLayout(left: LiveRtcAcceptedLayout, right: LiveRtcAcceptedLayout): boolean {
    return isSameGroupLayoutIdentity(left.identity, right.identity) &&
        JSON.stringify(toSortedAdjacency(left)) === JSON.stringify(toSortedAdjacency(right));
}

function toSortedAdjacency(layout: LiveRtcAcceptedLayout): readonly (readonly [string, readonly string[]])[] {
    return Object.entries(layout.nextHopsBySessionId)
        .map(([sessionId, peers]) => [sessionId, [...peers].sort()] as const)
        .sort(([left], [right]) => left.localeCompare(right));
}

/** Polls each browser's own accepted layout until all three hold the new one; never sleeps for it. */
async function waitForPromotion(
    scenario: LayoutSwitchScenario,
    expected: ExpectedPromotion
): Promise<ObservedPromotion> {
    let latest: readonly (LiveRtcAcceptedLayout | undefined)[] = [];
    try {
        await expect.poll(async () => {
            latest = await readAcceptedLayouts(scenario);
            const common = toCommonLayout(latest);
            return common !== undefined && !isSameGroupLayoutIdentity(common.identity, expected.previous) &&
                resolveLiveRtcLayoutShape(common, expected.sessionIds).kind === expected.kind;
        }, { timeout: PROMOTION_POLL_TIMEOUT_MS, intervals: [1_000] }).toBe(true);
    }
    catch (cause) {
        throw new Error(
            `${expected.label}: not every browser promoted a ${expected.kind} layout within ${PROMOTION_POLL_TIMEOUT_MS} ms; ` +
                `last read: ${JSON.stringify(latest)}`,
            { cause }
        );
    }
    const layout = toCommonLayout(latest);
    if (layout === undefined) {
        throw new Error(`${expected.label}: the promoted layout was not read`);
    }
    return { layout, detectedAtEpochMs: Date.now() };
}

function resolveTree(
    layout: LiveRtcAcceptedLayout,
    sessionIds: SessionIds
): Extract<LiveRtcLayoutShape, { kind: 'tree'; }> {
    const shape = resolveLiveRtcLayoutShape(layout, sessionIds);
    if (shape.kind !== 'tree') {
        throw new Error(`Switch 1 promoted a layout that is not a tree with one relay: ${JSON.stringify(layout)}`);
    }
    return shape;
}

/** The relay may change by an RTT re-plan; the spec reports it rather than adapting to the new tree. */
async function expectTreeHeld(scenario: LayoutSwitchScenario, tree: LiveRtcAcceptedLayout): Promise<void> {
    const current = await readCommonLayout(scenario, 'switch 2');
    if (!isSameLayout(current, tree)) {
        throw new Error(
            'The tree read after switch 1 is no longer the accepted layout when switch 2 is due ' +
                `(the relay changed): after switch 1 ${JSON.stringify(tree)}, now ${JSON.stringify(current)}`
        );
    }
}

/** Observation only: whether each leaf still held a ready lane to the other leaf as switch 2 was issued. */
async function readLeafToLeafReadiness(
    scenario: LayoutSwitchScenario,
    sessions: Readonly<Record<AgentPrefix, string>>,
    tree: Extract<LiveRtcLayoutShape, { kind: 'tree'; }>
): Promise<Readonly<Record<string, boolean>>> {
    const ready: Record<string, boolean> = {};
    for (const agent of scenario.agents) {
        const leafIndex = tree.leafSessionIds.indexOf(sessions[agent.prefix]);
        if (leafIndex >= 0) {
            const otherLeaf = tree.leafSessionIds[1 - leafIndex];
            const health = await scenario.operations.readHealth(agent);
            ready[agent.prefix] = health.rtcStatus.readyPeerIds.includes(otherLeaf);
        }
    }
    return ready;
}

/** Waits, bounded by the agent stream's own drain, for frames still travelling when the last stream reported. */
async function drainReceivers(
    scenario: LayoutSwitchScenario,
    streams: readonly LiveRtcLayoutSwitchStream[]
): Promise<readonly LiveRtcControlClient.Event[]> {
    const deadline = Date.now() + RALLAR_BLACK_BOX_RTC_STREAM_DEFAULT_DRAIN_TIMEOUT_MS;
    for (;;) {
        const { events } = await scenario.control.fetchRun(scenario.runId);
        if (countLiveRtcMissingFrames({ runId: scenario.runId, streams, events }) === 0 || Date.now() >= deadline) {
            return events;
        }
        await holdFor(scenario, 1_000);
    }
}

async function holdFor(scenario: LayoutSwitchScenario, ms: number): Promise<void> {
    if (ms > 0) {
        await scenario.agents[0].page.waitForTimeout(ms);
    }
}

/** Every condition is soft, so one red run names every condition it broke. */
function expectLayoutSwitchPasses(run: LayoutSwitchRun): void {
    const { evidence } = run;
    expect(evidence.runRetained, 'The control server dropped the start of the run; the evidence is incomplete').toBe(
        true
    );
    for (const [prefix, count] of Object.entries(evidence.inboundAdmissionCount)) {
        expect(count, `Browser ${prefix} recorded no inbound admission diagnostics`).toBeGreaterThan(0);
    }
    expectEveryFrameDelivered(evidence);
    expect.soft(
        evidence.unauthorizedAdmissions,
        `Unauthorized admissions during the run (first ${REPORTED_RECORDS}): ${
            JSON.stringify(evidence.unauthorizedAdmissions.slice(0, REPORTED_RECORDS))
        }`
    ).toHaveLength(0);
    expect.soft(
        evidence.senderPlannerDrops,
        `Planner drops at a sender (first ${REPORTED_RECORDS}): ${
            JSON.stringify(evidence.senderPlannerDrops.slice(0, REPORTED_RECORDS))
        }`
    ).toHaveLength(0);
    expectPromotionsInsideStreams(run);
    expectLeafCrossing(evidence);
}

function expectEveryFrameDelivered(evidence: LiveRtcLayoutSwitchEvidence): void {
    expect.soft(
        evidence.unsentFrames,
        `Frames a sender did not send (first ${REPORTED_RECORDS}): ${
            JSON.stringify(evidence.unsentFrames.slice(0, REPORTED_RECORDS))
        }`
    ).toHaveLength(0);
    for (const delivery of evidence.deliveries) {
        const stream = `browser ${delivery.origin}'s stream (${delivery.plannedFrames} frames)`;
        expect.soft(delivery.plannedFrames, `${stream} planned no frames`).toBeGreaterThan(0);
        expect.soft(delivery.missingSeqs, `Browser ${delivery.receiver} never received these seqs of ${stream}`)
            .toEqual([]);
        expect.soft(
            delivery.duplicatedSeqs,
            `Browser ${delivery.receiver}'s application received these seqs of ${stream} more than once`
        ).toEqual([]);
    }
}

function expectPromotionsInsideStreams(run: LayoutSwitchRun): void {
    const switchOnePromotions = run.evidence.promotions.map((promotion) => promotion.promotedAtEpochMs[0]);
    const lastSwitchOne = Math.max(...switchOnePromotions.map((promotedAt) => promotedAt ?? Infinity));
    expect.soft(
        run.requestedAtEpochMs[1] - lastSwitchOne,
        `Switch 2 was issued less than ${SWITCH_HOLD_MS} ms after the last browser promoted switch 1`
    ).toBeGreaterThanOrEqual(SWITCH_HOLD_MS);
    for (const promotion of run.evidence.promotions) {
        const window =
            `browser ${promotion.prefix}'s stream ran ${promotion.firstFrameAtEpochMs}..${promotion.lastFrameAtEpochMs}`;
        for (const [index, promotedAt] of promotion.promotedAtEpochMs.entries()) {
            expect.soft(promotedAt, `Browser ${promotion.prefix} recorded no promotion of switch ${index + 1}`)
                .not.toBeNull();
            expect.soft(
                (promotion.firstFrameAtEpochMs ?? Infinity) < (promotedAt ?? -Infinity) &&
                    (promotedAt ?? Infinity) < (promotion.lastFrameAtEpochMs ?? -Infinity),
                `Browser ${promotion.prefix} promoted switch ${index + 1} at ${promotedAt}, outside ${window}`
            ).toBe(true);
        }
        expect.soft(
            (promotion.lastFrameAtEpochMs ?? -Infinity) - (promotion.promotedAtEpochMs[1] ?? Infinity),
            `${window}, under ${SWITCH_HOLD_MS} ms past its promotion of switch 2`
        ).toBeGreaterThanOrEqual(SWITCH_HOLD_MS);
    }
}

/** The pinned case: a leaf's frames sent while it held the tree reached the other leaf, which it had no edge to. */
function expectLeafCrossing(evidence: LiveRtcLayoutSwitchEvidence): void {
    const crossed = evidence.leafCrossings.filter((crossing) =>
        crossing.framesSentOnTree > 0 && crossing.missingAtOtherLeaf.length === 0
    );
    expect.soft(
        crossed.length,
        `No leaf-origin stream's frames sent on the tree all reached the other leaf: ${
            JSON.stringify(evidence.leafCrossings)
        }`
    ).toBeGreaterThan(0);
}

async function attachRun(testInfo: TestInfo, run: LayoutSwitchRun): Promise<void> {
    const { evidence, ...scenario } = run;
    await testInfo.attach('layout-switch-observations.json', {
        body: JSON.stringify({ ...scenario, observations: evidence.observations }, null, 2),
        contentType: 'application/json'
    });
    await testInfo.attach('layout-switch-evidence.json', {
        body: JSON.stringify({ ...evidence, observations: undefined }, null, 2),
        contentType: 'application/json'
    });
}

async function retire(scenario: LayoutSwitchScenario, testInfo: TestInfo): Promise<void> {
    try {
        await scenario.control.attachRunSummary({ testInfo, runId: scenario.runId });
    }
    catch (error) {
        console.error('Failed to attach the layout-switch run summary', toError(error));
    }
    for (const error of await closeLiveRtcBrowserAgentContexts(scenario.agents)) {
        console.error('Failed to close a layout-switch agent', toError(error));
    }
}

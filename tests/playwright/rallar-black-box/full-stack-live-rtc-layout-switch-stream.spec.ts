import {
    expect,
    test,
    type APIRequestContext,
    type Browser,
    type TestInfo
} from '@playwright/test';
import { writeFile } from 'node:fs/promises';

import { RALLAR_BLACK_BOX_RTC_STREAM_DEFAULT_DRAIN_TIMEOUT_MS } from '@shared-test/rallar-bb-test/rtc-stream.ts';
import {
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { toError } from '@shared/resilience/to-error.ts';

import {
    computeLiveRtcLayoutSwitchEvidence,
    countLiveRtcMissingFrames,
    type LiveRtcLayoutSwitchEvidence,
    type LiveRtcLayoutSwitchStream
} from './compute-live-rtc-layout-switch-evidence.ts';
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
import { LiveRtcLayoutSwitchOperations, type LiveRtcStreamReliability } from './live-rtc-layout-switch-operations.ts';
import {
    resolveLiveRtcLayoutShape,
    toLiveRtcAcceptedLayout,
    type LiveRtcAcceptedLayout,
    type LiveRtcLayoutShape
} from './resolve-live-rtc-layout-shape.ts';

/**
 * Ruling 6 of the make-before-break plan, as the controller scoped it: three browsers each stream 10 frames a
 * second to the room while the owner switches the complete graph to a tree (an edge breaks) and, outside that
 * switch's overlap, back again (the edge returns). Which browser becomes the relay is unknown until the tree
 * exists, so every browser streams and every origin-receiver pair is checked. Evidence is what the browsers
 * already emit: their message events, ALM inbound diagnostics, send results, formation changes and health.
 */

const MESSAGES_RTC = { typeId: 'manual.type', topicId: 'manual.topic' } as const;
/**
 * The session's volatile send budget (`packages/shared/alm/volatile-budget/al-volatile-session-budget.ts`) refuses
 * an own send once the session holds more than 1 000 admissions AND its own sends more than their 500 share. An own
 * admission is held until its deadline, the send's 30 s TTL; an arrival for at most 30 s. At 10 Hz each session holds
 * at most 300 own admissions and 600 arrivals (two other streams), so no own send can pass either bound. At 20 Hz
 * the own pool reached 500 after 25 s and frames 501 on were refused. A relay's forward reuses the arrival's msgId,
 * which the budget already holds, so forwarding adds nothing.
 */
const STREAM_RATE_HZ = 10;
const STREAM_LEAD_MS = 3_000;
/** Outside the 15 s overlap of the previous switch, so the two promotions never share one overlap. */
const SWITCH_HOLD_MS = 16_000;
/** This spec's bound on each promotion poll; it also sizes the streams, which must be fixed before they start. */
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

/** What the run has read so far, written to the output directory in every outcome. */
interface LayoutSwitchProgress {
    sessions: Readonly<Record<AgentPrefix, string>> | null;
    servedOverlapMs: number | null;
    layoutReads: { label: string; readAtEpochMs: number; layouts: readonly (LiveRtcAcceptedLayout | undefined)[]; }[];
    switches: { label: string; requestedAtEpochMs: number; detectedAtEpochMs: number | null; }[];
    leafToLeafReadyAtSwitch2: Readonly<Record<string, boolean>> | null;
}

/** The two files every run writes: the evidence before asserting, the progress in every outcome. */
type LayoutSwitchEvidenceFile =
    | Readonly<{ progress: LayoutSwitchProgress; run: LayoutSwitchRun; }>
    | Readonly<LayoutSwitchProgress & { failure: string | null; }>;

interface LayoutSwitchScenario {
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly groupId: string;
    readonly suffix: string;
    readonly agents: LiveRtcAgentTrio;
    readonly operations: LiveRtcLayoutSwitchOperations;
    readonly progress: LayoutSwitchProgress;
}

type SessionIds = readonly [string, string, string];

interface SwitchRoom {
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly sessionIds: SessionIds;
    readonly formed: LiveRtcAcceptedLayout;
}

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
        test(
            `three ${reliability} 10 Hz streams cross an owner-issued tree switch and its reversal; ` +
                'every receiver takes 20 messages a second',
            async ({ browser, request }, testInfo) => {
                test.setTimeout(360_000);
                expectEvidenceSources();
                const scenario = await openScenario(browser, request);
                let failure: Error | undefined;
                try {
                    const run = await runLayoutSwitches(scenario, reliability);
                    await writeEvidenceFile(testInfo, 'layout-switch-evidence.json', {
                        progress: scenario.progress,
                        run
                    });
                    expectLayoutSwitchPasses(run);
                }
                catch (cause) {
                    failure = toError(cause);
                    throw cause;
                }
                finally {
                    await finishScenario(scenario, testInfo, failure);
                }
            }
        );
    }
});

function expectEvidenceSources(): void {
    expect(
        process.env.RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS,
        'The control server must keep every event: run with RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS=unbounded'
    ).toBe('unbounded');
    expect(almDiagnostics, 'Admission outcomes are read from the ALM inbound diagnostics').toBe(true);
    expect(routineBrowserDiagnostics, 'Formation changes and send results are routine diagnostics').toBe('enabled');
}

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
    const progress: LayoutSwitchProgress = {
        sessions: null,
        servedOverlapMs: null,
        layoutReads: [],
        switches: [],
        leafToLeafReadyAtSwitch2: null
    };
    return { control, runId, groupId, suffix, agents, operations, progress };
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
    scenario.progress.sessions = formation.sessions;
    return formation.sessions;
}

/** Step 1: the formed room is the complete graph, and the managed API serves the default overlap. */
async function readFormedLayout(
    scenario: LayoutSwitchScenario,
    sessionIds: SessionIds
): Promise<LiveRtcAcceptedLayout> {
    scenario.progress.servedOverlapMs = await scenario.operations.readServedOverlapMs() ?? null;
    expect(scenario.progress.servedOverlapMs, 'The managed API serves the default overlap in /api/config')
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
            frameTypeId: MESSAGES_RTC.typeId,
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
    room: SwitchRoom
): Promise<Omit<LayoutSwitchRun, 'sessions' | 'evidence'>> {
    const { sessionIds } = room;
    const treeRequestedAt = await requestSwitch(scenario, 'switch 1', 'tree');
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
    scenario.progress.leafToLeafReadyAtSwitch2 = leafToLeafReadyAtSwitch2;
    const starRequestedAt = await requestSwitch(scenario, 'switch 2', 'star');
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

async function requestSwitch(
    scenario: LayoutSwitchScenario,
    label: string,
    topologyKind: 'tree' | 'star'
): Promise<number> {
    const requestedAtEpochMs = await scenario.operations.writeTopologyKind(topologyKind);
    scenario.progress.switches.push({ label, requestedAtEpochMs, detectedAtEpochMs: null });
    return requestedAtEpochMs;
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

/** Reads each browser's accepted layout and keeps the latest read under its label for the progress file. */
async function readAcceptedLayouts(
    scenario: LayoutSwitchScenario,
    label: string
): Promise<readonly (LiveRtcAcceptedLayout | undefined)[]> {
    const layouts: (LiveRtcAcceptedLayout | undefined)[] = [];
    for (const agent of scenario.agents) {
        layouts.push(toLiveRtcAcceptedLayout((await scenario.operations.readHealth(agent)).formation));
    }
    const reads = scenario.progress.layoutReads.filter((read) => read.label !== label);
    scenario.progress.layoutReads = [...reads, { label, readAtEpochMs: Date.now(), layouts }];
    return layouts;
}

/** Every browser holds one accepted layout, the same identity with the same adjacency. */
async function readCommonLayout(scenario: LayoutSwitchScenario, label: string): Promise<LiveRtcAcceptedLayout> {
    const layouts = await readAcceptedLayouts(scenario, label);
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
            latest = await readAcceptedLayouts(scenario, expected.label);
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
    const detectedAtEpochMs = Date.now();
    const requested = scenario.progress.switches.find((entry) => entry.label === expected.label);
    if (requested !== undefined) {
        requested.detectedAtEpochMs = detectedAtEpochMs;
    }
    return { layout, detectedAtEpochMs };
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
    const current = await readCommonLayout(scenario, 'before switch 2');
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

/**
 * Reads the run until every receiver holds every planned frame, or until the missing count has not changed for the
 * agent stream's own drain bound (`RALLAR_BLACK_BOX_RTC_STREAM_DEFAULT_DRAIN_TIMEOUT_MS`), so frames whose events
 * are still being published are waited for as long as they keep arriving.
 */
async function drainReceivers(
    scenario: LayoutSwitchScenario,
    streams: readonly LiveRtcLayoutSwitchStream[]
): Promise<readonly LiveRtcControlClient.Event[]> {
    let lastMissing = Infinity;
    let lastChangedAtMs = Date.now();
    for (;;) {
        const { events } = await scenario.control.fetchRun(scenario.runId);
        const missing = countLiveRtcMissingFrames({ runId: scenario.runId, streams, events });
        if (missing !== lastMissing) {
            lastMissing = missing;
            lastChangedAtMs = Date.now();
        }
        if (missing === 0 || Date.now() - lastChangedAtMs >= RALLAR_BLACK_BOX_RTC_STREAM_DEFAULT_DRAIN_TIMEOUT_MS) {
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
    expect.soft(evidence.runRetained, 'The control server dropped the start of the run; the evidence is incomplete')
        .toBe(true);
    for (const [prefix, completeness] of Object.entries(evidence.admissionCompleteness)) {
        expect.soft(
            completeness.committedFrameAdmissions,
            `Browser ${prefix} recorded fewer committed frame admissions than frames it delivered ` +
                `(${completeness.receivedFrames} of ${completeness.expectedFrames} expected): ALM inbound diagnostics are incomplete`
        ).toBeGreaterThanOrEqual(Math.max(1, completeness.receivedFrames));
    }
    expectSendReadings(evidence);
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
    expectNoRelayForwardRefused(evidence);
    expectPromotionsInsideStreams(run);
    expectLeafCrossing(evidence);
}

/** The unsent-frame and sender planner-drop zeros are readings only when the streams they come from are present. */
function expectSendReadings(evidence: LiveRtcLayoutSwitchEvidence): void {
    for (const [prefix, readings] of Object.entries(evidence.sendReadings)) {
        expect.soft(
            readings.observedFrames,
            `Browser ${prefix}'s stream reported ${readings.observedFrames} frame observations for ` +
                `${readings.plannedFrames} planned frames: the unsent-frame reading would be incomplete`
        ).toBe(readings.plannedFrames);
        expect.soft(
            readings.sendCompletedEvents,
            `Browser ${prefix} recorded ${readings.sendCompletedEvents} send_completed events for ` +
                `${readings.plannedFrames} planned frames: the planner-drop reading would be empty otherwise`
        ).toBeGreaterThanOrEqual(Math.max(1, readings.plannedFrames));
    }
}

/**
 * A relay's forward that ends as anything but admitted, duplicate or pending is reported as
 * `relay-forward-not-enqueued`; `storage-unavailable` throws into a claim that retries, so it is only observed. The
 * zero is a reading only when the browser's outbound diagnostics were retained: every dispatch admission writes one
 * `commit-phases`, so its frame-type commits are at least its own planned frames.
 */
function expectNoRelayForwardRefused(evidence: LiveRtcLayoutSwitchEvidence): void {
    for (const [prefix, readings] of Object.entries(evidence.outboundReadings)) {
        expect.soft(
            readings.frameCommitPhases,
            `Browser ${prefix} published ${readings.frameCommitPhases} frame commit-phases outbound diagnostics for ` +
                `${readings.plannedFrames} planned frames: the relay-forward reading would be empty otherwise`
        ).toBeGreaterThanOrEqual(Math.max(1, readings.plannedFrames));
    }
    const byOutcome: Record<string, number> = {};
    for (const refusal of evidence.relayForwardRefusals) {
        const key = `${String(refusal.detail.outcome)} / ${String(refusal.detail.reason)}`;
        byOutcome[key] = (byOutcome[key] ?? 0) + 1;
    }
    const first = evidence.relayForwardRefusals.slice(0, REPORTED_RECORDS).map((refusal) => ({
        browser: refusal.agent,
        outcome: refusal.detail.outcome,
        reason: refusal.detail.reason,
        msgId: refusal.detail.msgId
    }));
    expect.soft(
        evidence.relayForwardRefusals.length,
        `Relay forwards refused, by outcome / reason: ${JSON.stringify(byOutcome)}; first ${REPORTED_RECORDS}: ${
            JSON.stringify(first)
        }`
    ).toBe(0);
}

function expectEveryFrameDelivered(evidence: LiveRtcLayoutSwitchEvidence): void {
    expect.soft(
        evidence.unsentFrames.length,
        `Frames a sender did not send, by state / failure / reason / limit: ${
            JSON.stringify(evidence.unsentByReason)
        }; the first in full: ${JSON.stringify(evidence.unsentFrames[0] ?? null)}`
    ).toBe(0);
    for (const delivery of evidence.deliveries) {
        const stream = `browser ${delivery.origin}'s stream (${delivery.plannedFrames} frames)`;
        expect.soft(delivery.plannedFrames, `${stream} planned no frames`).toBeGreaterThan(0);
        expect.soft(delivery.missingSeqs, `Browser ${delivery.receiver} never received these seqs of ${stream}`)
            .toEqual([]);
        expect.soft(
            delivery.duplicatedSeqs,
            `Browser ${delivery.receiver}'s application received these seqs of ${stream} more than once ` +
                '(the same msgId and transport twice is a double subscription in the harness)'
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

/**
 * A file in the test's output directory, attached by its path: an attachment by body exists only in the reporter,
 * which is why the first run left no evidence file beside its screenshots and trace.
 */
async function writeEvidenceFile(testInfo: TestInfo, name: string, value: LayoutSwitchEvidenceFile): Promise<void> {
    const path = testInfo.outputPath(name);
    await writeFile(path, JSON.stringify(value, null, 2));
    await testInfo.attach(name, { path, contentType: 'application/json' });
}

/**
 * Runs in every outcome, before the agents are retired. A capture that fails after the test's own error is only
 * logged, so it never replaces that error; on a run that was otherwise green it fails the test, because a broken
 * event-history continuity means the evidence the test passed on is incomplete.
 */
async function finishScenario(
    scenario: LayoutSwitchScenario,
    testInfo: TestInfo,
    failure: Error | undefined
): Promise<void> {
    let captureFailure: Error | undefined;
    const errors = [failure?.message, ...testInfo.errors.map((error) => error.message)].flatMap((message) =>
        message ?? []
    );
    try {
        await writeEvidenceFile(testInfo, 'layout-switch-progress.json', {
            failure: errors.length === 0 ? null : errors.join('\n'),
            ...scenario.progress
        });
    }
    catch (cause) {
        captureFailure = toError(cause);
        console.error('Failed to write the layout-switch progress', captureFailure);
    }
    try {
        await scenario.control.captureDiagnostics({
            testInfo,
            runId: scenario.runId,
            agents: scenario.agents,
            label: `layout-switch-${scenario.suffix}`,
            cycle: null
        });
    }
    catch (cause) {
        captureFailure = toError(cause);
        console.error('Failed to capture the layout-switch evidence', captureFailure);
    }
    await retire(scenario, testInfo);
    if (failure === undefined && captureFailure !== undefined) {
        throw captureFailure;
    }
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

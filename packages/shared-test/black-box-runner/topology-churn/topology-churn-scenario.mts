import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SESSION_HEARTBEAT_INTERVAL_MS } from '@shared-web/browser/session/browser-session-heartbeat.ts';
import { DEFAULT_STATE_HEARTBEAT_TTL_MSECS } from '@shared-web/browser/session/refresh-state-heartbeat.ts';
import type { AdminRoomTopologyPlan } from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import type { EffectiveGroupTopologyConfig } from '@shared/api/graph-topology-management-types.ts';
import { resolveRallarGroupLeaderSessionId } from '@shared/api/group-director.ts';
import { isSameGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { DEFAULT_RTT_REPORTING_DEGREE_LIMIT } from '@shared/rtc/rtt-reporting-policy.ts';

import { computeTopologyChurnDrift, type TopologyChurnDrift } from './compute-topology-churn-drift.ts';
import {
    computeTopologyChurnPhaseWindows,
    type TopologyChurnPhaseRun
} from './compute-topology-churn-phase-windows.ts';
import { computeTopologyChurnReport, type TopologyChurnPromotionSighting } from './compute-topology-churn-report.ts';
import { appointTopologyChurnLeader } from './phases/appoint-topology-churn-leader.mts';
import {
    computeTopologyChurnPhaseSchedule,
    TOPOLOGY_CHURN_INTERLEAVE_OFFSET_MS,
    TOPOLOGY_CHURN_INTERLEAVE_SLOTS,
    TOPOLOGY_CHURN_INTERVAL_MS,
    TOPOLOGY_CHURN_RTT_REPEAT_MS,
    type TopologyChurnAction,
    type TopologyChurnPhaseSchedule
} from './phases/compute-topology-churn-phase-schedule.ts';
import type { TopologyChurnRoomSpec } from './phases/topology-churn-room-specs.ts';
import { resolveNewPromotionSighting } from './resolve-new-promotion-sighting.ts';
import { resolveTopologyChurnEvent, type TopologyChurnEvent } from './resolve-topology-churn-event.ts';
import { resolveTopologyChurnOutcome, type TopologyChurnOutcome } from './resolve-topology-churn-outcome.ts';
import { TOPOLOGY_CHURN_RTT_MS } from './rtt/compute-topology-churn-rtt-matrix.ts';
import { TopologyChurnRttReporter } from './rtt/topology-churn-rtt-reporter.mts';
import type { TopologyChurnWsEndpoint } from './rtt/topology-churn-rtt-socket.mts';
import { toTopologyChurnLinkSample, type TopologyChurnLinkSample } from './to-topology-churn-link-sample.ts';
import { toTopologyChurnMarkdownTable, type TopologyChurnRoomEntry } from './to-topology-churn-markdown-table.ts';
import { toTopologyChurnMember } from './to-topology-churn-member.ts';
import { toTopologyChurnPolicy } from './to-topology-churn-policy.ts';
import type { TopologyChurnApi, TopologyChurnMember, TopologyChurnSession } from './topology-churn-api.mts';

const TOPOLOGY_CHURN_SETTLE_MS = 6_000;
const TOPOLOGY_CHURN_SAMPLE_INTERVAL_MS = 250;
export const TOPOLOGY_CHURN_REQUEST_TIMEOUT_MS = 30_000;

export interface TopologyChurnClock {
    nowEpochMs(): number;
    /** Resolves after the duration, or at once when the signal aborts. */
    sleep(durationMs: number, signal: AbortSignal): Promise<void>;
}

export namespace TopologyChurnScenario {
    export interface Input {
        readonly api: TopologyChurnApi;
        readonly clock: TopologyChurnClock;
        readonly artifactDir: string;
        /** The cluster's API processes; members are spread over them, the first serves the operator reads. */
        readonly apiBaseUrls: readonly string[];
        readonly rooms: readonly TopologyChurnRoomSpec[];
        /** The report's file name in the artifact directory. */
        readonly reportFile: string;
    }
}

const CONVERGENCE_BOUND_MS = 15_000;
const BURST_CONCURRENCY = 10;
const ADMINISTRATOR_CLIENT_IP = '10.0.0.1';
const APPLICATION_ID = 'topology-churn';

interface TopologyChurnRunContext {
    readonly administrator: TopologyChurnSession;
    readonly replacedLayoutOverlapMs: number;
    readonly endpointsByApiBaseUrl: ReadonlyMap<string, TopologyChurnWsEndpoint>;
}

interface TopologyChurnProgress {
    step: string;
}

interface PresentSession {
    readonly session: TopologyChurnSession;
    readonly presentSinceEpochMs: number;
}

interface TopologyChurnLeadership {
    leader: TopologyChurnSession | null;
}

interface ChurnRoom {
    readonly spec: TopologyChurnRoomSpec;
    readonly roomRef: GroupRef;
    readonly creator: TopologyChurnSession;
    readonly topologyConfig: EffectiveGroupTopologyConfig;
    readonly present: PresentSession[];
    /** The member last appointed director; it stays, as the creator does. */
    readonly leadership: TopologyChurnLeadership;
    /** Sends the room's RTT reports; it opens sockets only in a room whose spec opens them. */
    readonly rttReporter: TopologyChurnRttReporter;
    readonly sightings: TopologyChurnPromotionSighting[];
    readonly linkSamples: TopologyChurnLinkSample[];
    readonly progress: TopologyChurnProgress;
    readonly signal: AbortSignal;
}

interface ConvergedRoom {
    readonly plans: readonly AdminRoomTopologyPlan[];
    readonly outcome: TopologyChurnOutcome;
}

/** Liveness only: a failed or timed-out request, a room without a plan or a late convergence fails the run unreported. */
export class TopologyChurnScenario {
    readonly #input: TopologyChurnScenario.Input;
    readonly #runToken = crypto.randomUUID().slice(0, 8);
    readonly #workspaceId = crypto.randomUUID();
    #nextMemberIndex = 0;

    constructor(input: TopologyChurnScenario.Input) {
        this.#input = input;
    }

    async run(): Promise<void> {
        const primary = this.#input.apiBaseUrls[0];
        const configs = await Promise.all(
            this.#input.apiBaseUrls.map((apiBaseUrl) => this.#input.api.readApiConfig(apiBaseUrl))
        );
        const config = configs[0];
        const context: TopologyChurnRunContext = {
            administrator: await this.#input.api.loginAdministrator(primary, ADMINISTRATOR_CLIENT_IP),
            replacedLayoutOverlapMs: config.rtcReplacedLayoutOverlapMs,
            endpointsByApiBaseUrl: new Map(this.#input.apiBaseUrls.map((apiBaseUrl, index) => [apiBaseUrl, {
                wsBaseUrl: configs[index].wsBaseUrl,
                createWsPath: configs[index].endpoints.createWs
            }]))
        };
        const rooms: TopologyChurnRoomEntry[] = [];
        for (const spec of this.#input.rooms) {
            rooms.push(await this.#runRoom(spec, context));
        }
        await writeFile(
            join(this.#input.artifactDir, this.#input.reportFile),
            JSON.stringify(toReport(this.#input.rooms, rooms, config.rtcReplacedLayoutOverlapMs), null, 2)
        );
        console.log(rooms.map(toTopologyChurnMarkdownTable).join('\n\n'));
    }

    async #runRoom(spec: TopologyChurnRoomSpec, context: TopologyChurnRunContext): Promise<TopologyChurnRoomEntry> {
        const progress: TopologyChurnProgress = { step: 'creating the room' };
        const run = new AbortController();
        const roomRef: GroupRef = {
            applicationId: APPLICATION_ID,
            workspaceId: this.#workspaceId,
            groupId: `churn-${spec.index}-${spec.replanning}-${spec.memberCount}`
        };
        const rttReporter = new TopologyChurnRttReporter({
            api: this.#input.api,
            roomRef,
            endpointsByApiBaseUrl: context.endpointsByApiBaseUrl
        });
        try {
            const room = await this.#openRoom({ spec, roomRef, rttReporter, progress, signal: run.signal });
            const entry = await this.#measureWhileLive(room, context, run);
            progress.step = 'disconnecting the members still present';
            await this.#runConcurrently(
                new AbortController().signal,
                room.present.splice(0).map((present) => () =>
                    this.#input.api.disconnectPresence(present.session, room.roomRef)
                )
            );
            return entry;
        }
        catch (error) {
            throw new Error(
                `Room ${spec.index}, the ${spec.replanning} room of ${spec.memberCount} members, failed while ${progress.step}: ` +
                    String(error),
                { cause: error }
            );
        }
        finally {
            rttReporter.close();
            run.abort();
        }
    }

    async #openRoom(
        opening: Pick<ChurnRoom, 'spec' | 'roomRef' | 'rttReporter' | 'progress' | 'signal'>
    ): Promise<ChurnRoom> {
        const { spec, roomRef } = opening;
        const creator = await this.#signIn(this.#createMember(spec));
        await this.#input.api.createRoom({ creator, roomRef, topology: toTopologyChurnPolicy(spec.replanning) });
        opening.progress.step = 'reading the room\'s topology configuration';
        const topologyConfig = await this.#input.api.readEffectiveTopologyConfig(creator, roomRef);
        return {
            ...opening,
            creator,
            topologyConfig,
            present: [],
            leadership: { leader: null },
            sightings: [],
            linkSamples: []
        };
    }

    async #measureWhileLive(
        room: ChurnRoom,
        context: TopologyChurnRunContext,
        run: AbortController
    ): Promise<TopologyChurnRoomEntry> {
        const background = Promise.all([this.#sampleAcceptedLayouts(room), this.#renewPresenceLeases(room)]);
        try {
            return await Promise.race([
                this.#measureRoom(room, context),
                background.then((): never => {
                    throw new Error('The sampler and the lease renewals stopped before the measurement ended.');
                })
            ]);
        }
        finally {
            run.abort();
            await background.catch(() => undefined);
        }
    }

    async #measureRoom(room: ChurnRoom, context: TopologyChurnRunContext): Promise<TopologyChurnRoomEntry> {
        room.progress.step = 'forming the room';
        const formationStartedAtEpochMs = this.#input.clock.nowEpochMs();
        await this.#formRoom(room);
        const lastPresenceAnsweredAtEpochMs = Math.max(...room.present.map((present) => present.presentSinceEpochMs));
        const formationEndedAtEpochMs = lastPresenceAnsweredAtEpochMs + TOPOLOGY_CHURN_SETTLE_MS;
        if (room.spec.opensRttSockets) {
            await this.#openRttSockets(room);
        }
        await this.#sleepUntil(formationEndedAtEpochMs, room.signal);
        const runs = await this.#runPhases(room, formationEndedAtEpochMs);
        room.progress.step = 'waiting for the newest plan to be accepted';
        const converged = await this.#awaitConvergence(room, context.administrator);
        room.progress.step = 'reading the accepted layout';
        const drift = await this.#readDrift(room);
        const phases = computeTopologyChurnPhaseWindows({
            formationStartedAtEpochMs,
            lastPresenceAnsweredAtEpochMs,
            memberCount: room.spec.memberCount,
            settleMs: TOPOLOGY_CHURN_SETTLE_MS,
            runs
        });
        return {
            replanning: room.spec.replanning,
            memberCount: room.spec.memberCount,
            topology: converged.outcome.topology,
            report: computeTopologyChurnReport({
                plans: converged.plans,
                sightings: [...room.sightings],
                linkSamples: [...room.linkSamples],
                phases,
                replacedLayoutOverlapMs: context.replacedLayoutOverlapMs
            }),
            drift,
            topologyConfig: room.topologyConfig
        };
    }

    async #readDrift(room: ChurnRoom): Promise<TopologyChurnDrift> {
        const layout = await this.#input.api.readAcceptedLayout(room.creator, room.roomRef);
        const snapshot = await this.#input.api.readRoom(room.creator, room.roomRef);
        return computeTopologyChurnDrift({
            layout,
            leaderSessionId: resolveRallarGroupLeaderSessionId(snapshot),
            meshParamK: room.topologyConfig.meshParamK
        });
    }

    async #formRoom(room: ChurnRoom): Promise<void> {
        const joiners = Array.from({ length: room.spec.memberCount - 1 }, () => this.#createMember(room.spec));
        await this.#runConcurrently(room.signal, [
            () => this.#connectPresence(room, room.creator),
            ...joiners.map((member) => () => this.#enterRoom(room, member))
        ]);
    }

    /**
     * The pairs are chosen under the default RTT reporting limit, and the server selects them under the larger of that
     * limit and the room's degree limit, so the two must agree.
     */
    async #openRttSockets(room: ChurnRoom): Promise<void> {
        room.progress.step = 'opening the RTT sockets';
        if (room.topologyConfig.degreeLimit !== DEFAULT_RTT_REPORTING_DEGREE_LIMIT) {
            throw new Error(
                `the room's degree limit ${room.topologyConfig.degreeLimit} is not the RTT reporting limit ` +
                    `${DEFAULT_RTT_REPORTING_DEGREE_LIMIT} its reported pairs are chosen under`
            );
        }
        await room.rttReporter.open(room.present.map((present) => present.session));
    }

    async #runPhases(room: ChurnRoom, formationEndedAtEpochMs: number): Promise<readonly TopologyChurnPhaseRun[]> {
        const runs: TopologyChurnPhaseRun[] = [];
        let startedAtEpochMs = formationEndedAtEpochMs;
        for (const phase of room.spec.phases) {
            room.progress.step = `running the ${phase.name} phase`;
            const schedule = computeTopologyChurnPhaseSchedule({
                spec: phase,
                presentMemberCount: room.present.length,
                topologyConfig: room.topologyConfig
            });
            const run = await this.#runPhase(room, schedule, startedAtEpochMs);
            runs.push(run);
            startedAtEpochMs = run.endedAtEpochMs;
        }
        return runs;
    }

    async #runPhase(
        room: ChurnRoom,
        schedule: TopologyChurnPhaseSchedule,
        startedAtEpochMs: number
    ): Promise<TopologyChurnPhaseRun> {
        const events: TopologyChurnEvent[] = [];
        for (const step of schedule.steps) {
            await this.#sleepUntil(startedAtEpochMs + step.offsetMs, room.signal);
            events.push(await this.#applyStep(room, step.action));
        }
        await this.#sleepUntil(startedAtEpochMs + schedule.durationMs, room.signal);
        return { name: schedule.name, endedAtEpochMs: this.#input.clock.nowEpochMs(), events };
    }

    async #applyStep(room: ChurnRoom, action: TopologyChurnAction): Promise<TopologyChurnEvent> {
        if (action.kind === 'report-rtt') {
            return await this.#reportRtt(room, action);
        }
        if (action.kind === 'appoint') {
            const leader = await appointTopologyChurnLeader({
                api: this.#input.api,
                roomRef: room.roomRef,
                creator: room.creator,
                present: room.present.map((present) => present.session),
                leaderSessionId: room.leadership.leader?.sessionId ?? null,
                candidate: action.candidate
            });
            if (leader === null) {
                return { kind: 'skip' };
            }
            room.leadership.leader = leader;
            return { kind: 'appoint', memberId: leader.clientId };
        }
        const stayingMemberIds = [room.creator, room.leadership.leader].flatMap((session) =>
            session === null ? [] : [session.clientId]
        );
        const event = resolveTopologyChurnEvent({
            action,
            presentMembers: room.present.map((present) => ({
                memberId: present.session.clientId,
                presentSinceEpochMs: present.presentSinceEpochMs
            })),
            stayingMemberIds
        });
        await this.#applyChurnEvent(room, event);
        return event;
    }

    async #reportRtt(
        room: ChurnRoom,
        action: Extract<TopologyChurnAction, { kind: 'report-rtt'; }>
    ): Promise<TopologyChurnEvent> {
        const layout = await this.#input.api.readAcceptedLayout(room.creator, room.roomRef);
        return {
            kind: 'rtt-reports',
            reportCount: room.rttReporter.report({
                layout,
                shape: action.matrix,
                round: action.round,
                nowEpochMs: this.#input.clock.nowEpochMs()
            })
        };
    }

    async #applyChurnEvent(room: ChurnRoom, event: TopologyChurnEvent): Promise<void> {
        if (event.kind === 'join') {
            await this.#enterRoom(room, this.#createMember(room.spec));
            return;
        }
        if (event.kind === 'leave') {
            const leaver = room.present.find((present) => present.session.clientId === event.memberId);
            if (leaver === undefined) {
                throw new Error(`the member ${event.memberId} chosen to leave is not present`);
            }
            room.present.splice(room.present.indexOf(leaver), 1);
            await this.#input.api.disconnectPresence(leaver.session, room.roomRef);
        }
    }

    async #awaitConvergence(room: ChurnRoom, administrator: TopologyChurnSession): Promise<ConvergedRoom> {
        const deadlineEpochMs = this.#input.clock.nowEpochMs() + CONVERGENCE_BOUND_MS;
        for (;;) {
            const plans = await this.#input.api.readRoomTopologyPlans(administrator, room.roomRef);
            const snapshot = await this.#input.api.readRoom(room.creator, room.roomRef);
            const outcome = resolveTopologyChurnOutcome({
                plans,
                acceptedLayout: snapshot.group.acceptedLayoutIdentity
            });
            if (outcome.converged) {
                return { plans, outcome };
            }
            if (this.#input.clock.nowEpochMs() >= deadlineEpochMs) {
                throw new Error(
                    outcome.topology.length === 0
                        ? 'the room produced no plan'
                        : `the newest plan was not the accepted layout within ${CONVERGENCE_BOUND_MS} ms`
                );
            }
            await this.#sleepUntil(this.#input.clock.nowEpochMs() + TOPOLOGY_CHURN_SAMPLE_INTERVAL_MS, room.signal);
        }
    }

    async #sampleAcceptedLayouts(room: ChurnRoom): Promise<void> {
        try {
            while (!room.signal.aborted) {
                const snapshot = await this.#input.api.readRoom(room.creator, room.roomRef);
                const sighting = resolveNewPromotionSighting({
                    sightings: room.sightings,
                    acceptedLayout: snapshot.group.acceptedLayoutIdentity,
                    seenAtEpochMs: this.#input.clock.nowEpochMs()
                });
                if (sighting !== null) {
                    room.sightings.push(sighting);
                    await this.#sampleLinks(room);
                }
                await this.#input.clock.sleep(TOPOLOGY_CHURN_SAMPLE_INTERVAL_MS, room.signal);
            }
        }
        catch (error) {
            throw new Error(`sampling the accepted layout: ${String(error)}`, { cause: error });
        }
    }

    /** Kept under the identity of the layout read, which may be newer than the one sighted. */
    async #sampleLinks(room: ChurnRoom): Promise<void> {
        const layout = await this.#input.api.readAcceptedLayout(room.creator, room.roomRef);
        const sample = toTopologyChurnLinkSample(layout, room.topologyConfig.meshParamK);
        if (
            sample !== null && !room.linkSamples.some((kept) => isSameGroupLayoutIdentity(kept.layout, sample.layout))
        ) {
            room.linkSamples.push(sample);
        }
    }

    async #renewPresenceLeases(room: ChurnRoom): Promise<void> {
        try {
            await this.#input.clock.sleep(SESSION_HEARTBEAT_INTERVAL_MS, room.signal);
            while (!room.signal.aborted) {
                for (const present of [...room.present]) {
                    if (room.signal.aborted) {
                        return;
                    }
                    await this.#input.api.sendHeartbeat({
                        session: present.session,
                        roomRef: room.roomRef,
                        leaseExpiresAtEpochMs: this.#toLeaseExpiresAtEpochMs()
                    });
                }
                await this.#input.clock.sleep(SESSION_HEARTBEAT_INTERVAL_MS, room.signal);
            }
        }
        catch (error) {
            throw new Error(`renewing presence leases: ${String(error)}`, { cause: error });
        }
    }

    async #enterRoom(room: ChurnRoom, member: TopologyChurnMember): Promise<void> {
        const session = await this.#signIn(member);
        await this.#input.api.joinRoom(session, room.roomRef);
        await this.#connectPresence(room, session);
    }

    async #signIn(member: TopologyChurnMember): Promise<TopologyChurnSession> {
        await this.#input.api.registerMember(member);
        return await this.#input.api.loginMember(member);
    }

    async #connectPresence(room: ChurnRoom, session: TopologyChurnSession): Promise<void> {
        await this.#input.api.connectPresence({
            session,
            roomRef: room.roomRef,
            leaseExpiresAtEpochMs: this.#toLeaseExpiresAtEpochMs()
        });
        room.present.push({ session, presentSinceEpochMs: this.#input.clock.nowEpochMs() });
    }

    /** Runs the tasks at most ten at a time; the first failure stops the tasks not yet started. */
    async #runConcurrently(signal: AbortSignal, tasks: readonly (() => Promise<void>)[]): Promise<void> {
        const queue = [...tasks];
        const drain = async (): Promise<void> => {
            for (let task = queue.shift(); task !== undefined; task = queue.shift()) {
                signal.throwIfAborted();
                try {
                    await task();
                }
                catch (error) {
                    queue.length = 0;
                    throw error;
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(BURST_CONCURRENCY, queue.length) }, drain));
    }

    async #sleepUntil(epochMs: number, signal: AbortSignal): Promise<void> {
        await this.#input.clock.sleep(Math.max(0, epochMs - this.#input.clock.nowEpochMs()), signal);
        signal.throwIfAborted();
    }

    #createMember(spec: TopologyChurnRoomSpec): TopologyChurnMember {
        const memberIndex = this.#nextMemberIndex;
        this.#nextMemberIndex += 1;
        return toTopologyChurnMember({
            runToken: this.#runToken,
            roomIndex: spec.index,
            memberIndex,
            apiBaseUrls: this.#input.apiBaseUrls
        });
    }

    #toLeaseExpiresAtEpochMs(): number {
        return this.#input.clock.nowEpochMs() + DEFAULT_STATE_HEARTBEAT_TTL_MSECS;
    }
}

function toReport(
    roomSpecs: readonly TopologyChurnRoomSpec[],
    rooms: readonly TopologyChurnRoomEntry[],
    servedReplacedLayoutOverlapMs: number
): object {
    return {
        schema: 'rallar.topology-churn.report.v2',
        constants: {
            roomSpecs,
            intervalMs: TOPOLOGY_CHURN_INTERVAL_MS,
            interleaveSlots: TOPOLOGY_CHURN_INTERLEAVE_SLOTS,
            interleaveOffsetMs: TOPOLOGY_CHURN_INTERLEAVE_OFFSET_MS,
            rttMs: TOPOLOGY_CHURN_RTT_MS,
            rttRepeatMs: TOPOLOGY_CHURN_RTT_REPEAT_MS,
            settleMs: TOPOLOGY_CHURN_SETTLE_MS,
            sampleIntervalMs: TOPOLOGY_CHURN_SAMPLE_INTERVAL_MS,
            requestTimeoutMs: TOPOLOGY_CHURN_REQUEST_TIMEOUT_MS,
            convergenceBoundMs: CONVERGENCE_BOUND_MS,
            burstConcurrency: BURST_CONCURRENCY,
            presenceLeaseMs: DEFAULT_STATE_HEARTBEAT_TTL_MSECS,
            heartbeatIntervalMs: SESSION_HEARTBEAT_INTERVAL_MS
        },
        servedReplacedLayoutOverlapMs,
        rooms
    };
}

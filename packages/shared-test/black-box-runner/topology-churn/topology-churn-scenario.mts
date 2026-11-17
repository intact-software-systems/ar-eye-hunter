import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SESSION_HEARTBEAT_INTERVAL_MS } from '@shared-web/browser/session/browser-session-heartbeat.ts';
import { DEFAULT_STATE_HEARTBEAT_TTL_MSECS } from '@shared-web/browser/session/refresh-state-heartbeat.ts';
import type { AdminRoomTopologyPlan } from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import { resolveRallarGroupLeaderSessionId } from '@shared/api/group-director.ts';
import type { GroupTopologyReplanningMode } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { computeTopologyChurnDrift, type TopologyChurnDrift } from './compute-topology-churn-drift.ts';
import { computeTopologyChurnPhaseWindows } from './compute-topology-churn-phase-windows.ts';
import { computeTopologyChurnReport, type TopologyChurnPromotionSighting } from './compute-topology-churn-report.ts';
import { resolveNewPromotionSighting } from './resolve-new-promotion-sighting.ts';
import { resolveTopologyChurnEvent, type TopologyChurnEvent } from './resolve-topology-churn-event.ts';
import { resolveTopologyChurnOutcome, type TopologyChurnOutcome } from './resolve-topology-churn-outcome.ts';
import { toTopologyChurnMarkdownTable, type TopologyChurnRoomEntry } from './to-topology-churn-markdown-table.ts';
import { toTopologyChurnMember } from './to-topology-churn-member.ts';
import { toTopologyChurnPolicy } from './to-topology-churn-policy.ts';
import type { TopologyChurnApi, TopologyChurnMember, TopologyChurnSession } from './topology-churn-api.mts';

const TOPOLOGY_CHURN_MEMBER_COUNTS = [3, 8, 20] as const;
const TOPOLOGY_CHURN_REPLANNING_MODES = [
    'auto',
    'debounced'
] as const satisfies readonly GroupTopologyReplanningMode[];
const TOPOLOGY_CHURN_INTERVAL_MS = 3_000;
const TOPOLOGY_CHURN_DURATION_MS = 90_000;
const TOPOLOGY_CHURN_SETTLE_MS = 6_000;
const TOPOLOGY_CHURN_SAMPLE_INTERVAL_MS = 250;
export const TOPOLOGY_CHURN_REQUEST_TIMEOUT_MS = 30_000;
export const TOPOLOGY_CHURN_REPORT_FILE = 'topology-churn-report.json';

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
    }
}

const CONVERGENCE_BOUND_MS = 15_000;
const BURST_CONCURRENCY = 10;
const ADMINISTRATOR_CLIENT_IP = '10.0.0.1';
const APPLICATION_ID = 'topology-churn';

interface TopologyChurnRoomSpec {
    readonly index: number;
    readonly replanning: GroupTopologyReplanningMode;
    readonly memberCount: number;
}

interface TopologyChurnRunContext {
    readonly administrator: TopologyChurnSession;
    readonly replacedLayoutOverlapMs: number;
}

interface TopologyChurnProgress {
    step: string;
}

interface PresentSession {
    readonly session: TopologyChurnSession;
    readonly presentSinceEpochMs: number;
}

interface ChurnRoom {
    readonly spec: TopologyChurnRoomSpec;
    readonly roomRef: GroupRef;
    readonly creator: TopologyChurnSession;
    readonly present: PresentSession[];
    readonly sightings: TopologyChurnPromotionSighting[];
    readonly progress: TopologyChurnProgress;
    readonly signal: AbortSignal;
}

interface ChurnPhase {
    readonly endedAtEpochMs: number;
    readonly events: readonly TopologyChurnEvent[];
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
        const config = await this.#input.api.readApiConfig(primary);
        const context: TopologyChurnRunContext = {
            administrator: await this.#input.api.loginAdministrator(primary, ADMINISTRATOR_CLIENT_IP),
            replacedLayoutOverlapMs: config.rtcReplacedLayoutOverlapMs
        };
        const rooms: TopologyChurnRoomEntry[] = [];
        for (const spec of toRoomSpecs()) {
            rooms.push(await this.#runRoom(spec, context));
        }
        await writeFile(
            join(this.#input.artifactDir, TOPOLOGY_CHURN_REPORT_FILE),
            JSON.stringify(toReport(rooms, config.rtcReplacedLayoutOverlapMs), null, 2)
        );
        console.log(rooms.map(toTopologyChurnMarkdownTable).join('\n\n'));
    }

    async #runRoom(spec: TopologyChurnRoomSpec, context: TopologyChurnRunContext): Promise<TopologyChurnRoomEntry> {
        const progress: TopologyChurnProgress = { step: 'creating the room' };
        const run = new AbortController();
        try {
            const room = await this.#openRoom(spec, progress, run.signal);
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
                `The ${spec.replanning} room of ${spec.memberCount} members failed while ${progress.step}: ` +
                    String(error),
                { cause: error }
            );
        }
        finally {
            run.abort();
        }
    }

    async #openRoom(
        spec: TopologyChurnRoomSpec,
        progress: TopologyChurnProgress,
        signal: AbortSignal
    ): Promise<ChurnRoom> {
        const roomRef: GroupRef = {
            applicationId: APPLICATION_ID,
            workspaceId: this.#workspaceId,
            groupId: `churn-${spec.replanning}-${spec.memberCount}`
        };
        const creator = await this.#signIn(this.#createMember(spec));
        await this.#input.api.createRoom({ creator, roomRef, topology: toTopologyChurnPolicy(spec.replanning) });
        return { spec, roomRef, creator, present: [], sightings: [], progress, signal };
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
        await this.#sleepUntil(formationEndedAtEpochMs, room.signal);
        room.progress.step = 'churning';
        const churn = await this.#churnRoom(room, formationEndedAtEpochMs);
        room.progress.step = 'waiting for the newest plan to be accepted';
        const converged = await this.#awaitConvergence(room, context.administrator);
        room.progress.step = 'reading the accepted layout';
        const drift = await this.#readDrift(room);
        const phases = computeTopologyChurnPhaseWindows({
            formationStartedAtEpochMs,
            lastPresenceAnsweredAtEpochMs,
            memberCount: room.spec.memberCount,
            settleMs: TOPOLOGY_CHURN_SETTLE_MS,
            churnEndedAtEpochMs: churn.endedAtEpochMs,
            churnEvents: churn.events
        });
        return {
            replanning: room.spec.replanning,
            memberCount: room.spec.memberCount,
            topology: converged.outcome.topology,
            report: computeTopologyChurnReport({
                plans: converged.plans,
                sightings: [...room.sightings],
                phases,
                replacedLayoutOverlapMs: context.replacedLayoutOverlapMs
            }),
            drift
        };
    }

    async #readDrift(room: ChurnRoom): Promise<TopologyChurnDrift> {
        const layout = await this.#input.api.readAcceptedLayout(room.creator, room.roomRef);
        const snapshot = await this.#input.api.readRoom(room.creator, room.roomRef);
        return computeTopologyChurnDrift({ layout, leaderSessionId: resolveRallarGroupLeaderSessionId(snapshot) });
    }

    async #formRoom(room: ChurnRoom): Promise<void> {
        const joiners = Array.from({ length: room.spec.memberCount - 1 }, () => this.#createMember(room.spec));
        await this.#runConcurrently(room.signal, [
            () => this.#connectPresence(room, room.creator),
            ...joiners.map((member) => () => this.#enterRoom(room, member))
        ]);
    }

    async #churnRoom(room: ChurnRoom, startedAtEpochMs: number): Promise<ChurnPhase> {
        const events: TopologyChurnEvent[] = [];
        for (
            let eventIndex = 0;
            eventIndex * TOPOLOGY_CHURN_INTERVAL_MS < TOPOLOGY_CHURN_DURATION_MS;
            eventIndex += 1
        ) {
            await this.#sleepUntil(startedAtEpochMs + eventIndex * TOPOLOGY_CHURN_INTERVAL_MS, room.signal);
            const event = resolveTopologyChurnEvent({
                presentMembers: room.present.map((present) => ({
                    memberId: present.session.clientId,
                    presentSinceEpochMs: present.presentSinceEpochMs
                })),
                creatorMemberId: room.creator.clientId,
                eventIndex
            });
            await this.#applyChurnEvent(room, event);
            events.push(event);
        }
        await this.#sleepUntil(startedAtEpochMs + TOPOLOGY_CHURN_DURATION_MS, room.signal);
        return { endedAtEpochMs: this.#input.clock.nowEpochMs(), events };
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
                }
                await this.#input.clock.sleep(TOPOLOGY_CHURN_SAMPLE_INTERVAL_MS, room.signal);
            }
        }
        catch (error) {
            throw new Error(`sampling the accepted layout: ${String(error)}`, { cause: error });
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

function toRoomSpecs(): readonly TopologyChurnRoomSpec[] {
    return TOPOLOGY_CHURN_REPLANNING_MODES.flatMap((replanning) =>
        TOPOLOGY_CHURN_MEMBER_COUNTS.map((memberCount) => ({ replanning, memberCount }))
    ).map((spec, index) => ({ ...spec, index }));
}

function toReport(rooms: readonly TopologyChurnRoomEntry[], servedReplacedLayoutOverlapMs: number): object {
    return {
        schema: 'rallar.topology-churn.report.v1',
        constants: {
            memberCounts: TOPOLOGY_CHURN_MEMBER_COUNTS,
            replanningModes: TOPOLOGY_CHURN_REPLANNING_MODES,
            intervalMs: TOPOLOGY_CHURN_INTERVAL_MS,
            durationMs: TOPOLOGY_CHURN_DURATION_MS,
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

import type { RallarDirectorStatus } from '@shared-web/browser/rallar.ts';
import { RallarGameDirectorAppointmentRuntime } from './director/rallar-game-director-appointment-runtime.ts';
import { RallarGameDirectorRelayRuntime } from './director/rallar-game-director-relay-runtime.ts';
import { RallarGameHostElectionRuntime } from './director/rallar-game-host-election-runtime.ts';
import { RallarGameDiagnosticsRuntime } from './match/rallar-game-diagnostics-runtime.ts';
import type {
    RallarGameMatchConfig,
    RallarGameMatchHandle,
    RallarGameTypeIds
} from './match/rallar-game-match-contracts.ts';
import { RallarGameMatchEgressRuntime } from './match/rallar-game-match-egress-runtime.ts';
import { RallarGameMatchLifecycleRuntime } from './match/rallar-game-match-lifecycle-runtime.ts';
import { RallarGameMatchRoutingRuntime } from './match/rallar-game-match-routing-runtime.ts';
import { RallarGameMatchStatusRuntime } from './match/rallar-game-match-status-runtime.ts';
import { resolveRallarGameLaneIds, type RallarGameLaneIds } from './transport/lanes.ts';
import { RallarGamePresenceEgressRuntime } from './transport/rallar-game-presence-egress-runtime.ts';

const DEFAULT_RALLAR_GAME_HEARTBEAT_TTL_MS = 10_000;

export function resolveRallarGameTypeIds(
    topicId: string,
    typeIds: Partial<RallarGameTypeIds> = {}
): RallarGameTypeIds {
    return {
        capability: `${topicId}.capability.v1`,
        intent: `${topicId}.intent.v1`,
        event: `${topicId}.event.v1`,
        snapshot: `${topicId}.snapshot.v1`,
        syncRequest: `${topicId}.sync-request.v1`,
        heartbeat: `${topicId}.heartbeat.v1`,
        ...typeIds
    };
}

export function createRallarGameMatch<TInput, TIntent, TSnapshot, TEvent, TPresence = TInput>(
    config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence>
): RallarGameMatchHandle<TInput, TIntent, TSnapshot, TEvent, TPresence> {
    return new RallarGameMatchRuntime(config).handle;
}

/** Composes the completed match owners exposed by the public match handle. */
class RallarGameMatchRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence> {
    readonly handle: RallarGameMatchHandle<TInput, TIntent, TSnapshot, TEvent, TPresence>;

    private readonly config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private readonly laneIds: RallarGameLaneIds;
    private readonly typeIds: RallarGameTypeIds;
    private readonly appointment: RallarGameDirectorAppointmentRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private readonly status: RallarGameMatchStatusRuntime;
    private readonly routing: RallarGameMatchRoutingRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private readonly election: RallarGameHostElectionRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private readonly directorRelay: RallarGameDirectorRelayRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private readonly egress: RallarGameMatchEgressRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private readonly presenceEgress: RallarGamePresenceEgressRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private readonly lifecycle: RallarGameMatchLifecycleRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private readonly diagnostics: RallarGameDiagnosticsRuntime;

    constructor(config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence>) {
        this.config = config;
        this.laneIds = resolveRallarGameLaneIds(config.laneIds);
        this.typeIds = resolveRallarGameTypeIds(config.topicId, config.typeIds);
        this.appointment = this.createAppointmentRuntime();
        this.status = this.createStatusRuntime();
        this.routing = this.createRoutingRuntime();
        this.election = this.createElectionRuntime();
        this.directorRelay = this.createDirectorRelayRuntime();
        this.egress = this.createEgressRuntime();
        this.presenceEgress = this.createPresenceEgressRuntime();
        this.lifecycle = this.createLifecycleRuntime();
        this.diagnostics = this.createDiagnosticsRuntime();
        this.handle = this.createHandle();
    }

    private createAppointmentRuntime(): RallarGameDirectorAppointmentRuntime<
        TInput,
        TIntent,
        TSnapshot,
        TEvent,
        TPresence
    > {
        return new RallarGameDirectorAppointmentRuntime({
            config: this.config,
            heartbeatTtlMs: this.config.heartbeatTtlMs ?? DEFAULT_RALLAR_GAME_HEARTBEAT_TTL_MS,
            readRoomTarget: () => this.readRoomTarget(),
            readDirectorStatus: () => this.readDirectorStatus()
        });
    }

    private createStatusRuntime(): RallarGameMatchStatusRuntime {
        return new RallarGameMatchStatusRuntime({
            protocol: this.config.protocol,
            topicId: this.config.topicId,
            readRoomTarget: (directorStatus) => this.readRoomTarget(directorStatus),
            readLocalPeerId: () => this.readLocalPeerId(),
            readDirectorStatus: () => this.readDirectorStatus(),
            readAppointmentEligibility: () => this.appointment.eligibility()
        });
    }

    private createRoutingRuntime(): RallarGameMatchRoutingRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence> {
        return new RallarGameMatchRoutingRuntime({
            config: this.config,
            status: this.status,
            readRoomTarget: () => this.readRoomTarget(),
            readLocalPeerId: () => this.readLocalPeerId()
        });
    }

    private createElectionRuntime(): RallarGameHostElectionRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence> {
        return new RallarGameHostElectionRuntime({
            config: this.config,
            typeIds: this.typeIds,
            routing: this.routing,
            appointment: this.appointment,
            status: this.status,
            readRoomTarget: () => this.readRoomTarget(),
            readLocalPeerId: () => this.readLocalPeerId()
        });
    }

    private createDirectorRelayRuntime(): RallarGameDirectorRelayRuntime<
        TInput,
        TIntent,
        TSnapshot,
        TEvent,
        TPresence
    > {
        return new RallarGameDirectorRelayRuntime({
            config: this.config,
            laneIds: this.laneIds,
            typeIds: this.typeIds,
            heartbeatTtlMs: this.config.heartbeatTtlMs ?? DEFAULT_RALLAR_GAME_HEARTBEAT_TTL_MS,
            isStopped: () => this.status.isStopped,
            readFreshDirectorStatus: () => this.status.readFreshDirectorStatus(),
            createEnvelope: (kind, payload, options) => this.routing.createEnvelope(kind, payload, options),
            routeEnvelope: async (envelope, kind, handler) => {
                await this.routing.routeEnvelope(envelope, kind, handler);
            },
            handleEnvelope: async (input) => await this.routing.handleRelayEnvelope(input),
            syncRequested: (atEpochMs) => this.status.recordSyncRequest(atEpochMs)
        });
    }

    private createEgressRuntime(): RallarGameMatchEgressRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence> {
        return new RallarGameMatchEgressRuntime({
            config: this.config,
            laneIds: this.laneIds,
            isStopped: () => this.status.isStopped,
            readRoomTarget: () => this.readRoomTarget(),
            readFreshDirectorStatus: () => this.status.readFreshDirectorStatus(),
            createEnvelope: (kind, payload, options) => this.routing.createEnvelope(kind, payload, options),
            routeEnvelope: async (envelope, kind, handler) => {
                await this.routing.routeEnvelope(envelope, kind, handler);
            },
            sendReliableSnapshot: async (envelope) => await this.directorRelay.sendSnapshot(envelope),
            realtimeEgressChanged: (state) => this.status.setRealtimeEgress(state)
        });
    }

    private createPresenceEgressRuntime(): RallarGamePresenceEgressRuntime<
        TInput,
        TIntent,
        TSnapshot,
        TEvent,
        TPresence
    > {
        return new RallarGamePresenceEgressRuntime({
            config: this.config,
            laneIds: this.laneIds,
            isStopped: () => this.status.isStopped,
            readStatus: () => this.status.current,
            readRoomTarget: () => this.readRoomTarget(),
            createEnvelope: (kind, payload, options) => this.routing.createEnvelope(kind, payload, options)
        });
    }

    private createLifecycleRuntime(): RallarGameMatchLifecycleRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence> {
        return new RallarGameMatchLifecycleRuntime({
            config: this.config,
            laneIds: this.laneIds,
            typeIds: this.typeIds,
            status: this.status,
            routing: this.routing,
            election: this.election,
            directorRelay: this.directorRelay,
            readRoomTarget: () => this.readRoomTarget()
        });
    }

    private createDiagnosticsRuntime(): RallarGameDiagnosticsRuntime {
        return new RallarGameDiagnosticsRuntime({
            rallar: this.config.rallar,
            laneIds: this.laneIds,
            readStatus: () => this.status.current,
            readElection: () => this.election.election(),
            readAppointment: () => this.appointment.eligibility(),
            readLastAppointment: () => this.appointment.lastResult,
            readPeerReadiness: () => this.egress.peerReadiness,
            readCapabilities: () => this.election.capabilities
        });
    }

    private createHandle(): RallarGameMatchHandle<TInput, TIntent, TSnapshot, TEvent, TPresence> {
        return {
            start: async () => await this.lifecycle.start(),
            stop: () => this.lifecycle.stop(),
            status: () => this.status.current,
            diagnostics: () => this.diagnostics.read(),
            canAppointDirector: () => this.appointment.eligibility(),
            reportCapability: (capability) => this.election.reportCapability(capability),
            election: () => this.election.election(),
            appointIfElected: async () => {
                const result = await this.appointment.appointIfElected(this.election.election());
                this.status.refresh(result.directorStatus);
                return result;
            },
            waitForReadyLanes: (options) => this.egress.waitForReadyLanes(options),
            sendPresence: (presence, options) => this.presenceEgress.send(presence, options),
            sendInput: (input) => this.egress.sendInput(input),
            sendIntent: (intent) => this.directorRelay.sendIntent(intent),
            publishSnapshot: (snapshot, options) => this.egress.publishSnapshot(snapshot, options),
            publishEvent: (event) => this.directorRelay.publishEvent(event),
            requestSync: (payload) => this.directorRelay.requestSync(payload),
            onPresence: (handler) => this.routing.onPresence(handler),
            onStatus: (handler) => this.status.onStatus(handler)
        };
    }

    private readDirectorStatus(): RallarDirectorStatus {
        const room = this.readRoomTarget();
        return this.config.rallar.director.status(room.roomRef ?? room.roomId);
    }

    private readRoomTarget(
        directorStatus?: RallarDirectorStatus
    ): RallarGameMatchStatusRuntime.RoomTarget {
        const roomState = this.config.rallar.rooms.state();
        const roomRef = this.config.roomRef ??
            directorStatus?.roomRef ??
            roomState.currentRoomRef;
        const roomId = this.config.roomId ??
            roomRef?.groupId ??
            directorStatus?.roomId ??
            roomState.currentRoomId;
        return { roomId, roomRef };
    }

    private readLocalPeerId(): string | undefined {
        return this.config.rallar.session()?.sessionId;
    }
}

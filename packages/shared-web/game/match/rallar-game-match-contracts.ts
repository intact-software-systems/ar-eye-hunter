import type { RallarFacade, RallarRoomState, RallarUnsubscribe } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarGameHostCapability, RallarGameHostElectionResult } from '../director/election.ts';
import type {
    RallarGameDirectorAppointmentContext,
    RallarGameDirectorAppointmentEligibility,
    RallarGameDirectorAppointmentPolicy,
    RallarGameHostAppointResult
} from '../director/rallar-game-director-appointment-contracts.ts';
import type { RallarGameEnvelope } from '../envelopes.ts';
import type { RallarGameLaneIds } from '../transport/lanes.ts';
import type { RallarGamePresenceSendOptions } from '../transport/rallar-game-presence-send-options.ts';
import type { RallarGameSendResult } from '../transport/rallar-game-send-result.ts';
import type { RallarGameDiagnostics } from './diagnostics.ts';
import type { RallarGameLaneReadyOptions, RallarGamePeerReadiness } from './rallar-game-match-egress-contracts.ts';
import type { RallarGameMatchStatus, RallarGameStatusHandler } from './rallar-game-match-status.ts';

export type RallarGameRallarFacade = Pick<
    RallarFacade,
    | 'session'
    | 'subscriptions'
    | 'rooms'
    | 'people'
    | 'director'
    | 'rtc'
    | 'realtime'
    | 'messages'
    | 'ws'
>;

export interface RallarGameTypeIds {
    readonly capability: string;
    readonly intent: string;
    readonly event: string;
    readonly snapshot: string;
    readonly syncRequest: string;
    readonly heartbeat: string;
}

export type RallarGameEnvelopeHandler<T> = (
    envelope: RallarGameEnvelope<T>
) => void | Promise<void>;

export interface RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence = TInput> {
    readonly rallar: RallarGameRallarFacade;
    readonly protocol: string;
    readonly topicId: string;
    readonly matchId?: string;
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly laneIds?: Partial<RallarGameLaneIds>;
    readonly typeIds?: Partial<RallarGameTypeIds>;
    readonly heartbeatTtlMs?: number;
    readonly capabilityTtlMs?: number;
    readonly readCapability?: () => Omit<RallarGameHostCapability, 'peerId' | 'reportedAtEpochMs'>;
    readonly resolvePeerIds?: (roomState: RallarRoomState) => readonly string[];
    readonly scoreHost?: (capability: RallarGameHostCapability) => number;
    readonly directorAppointmentPolicy?: RallarGameDirectorAppointmentPolicy;
    readonly canAppointDirector?: (
        context: RallarGameDirectorAppointmentContext
    ) => RallarGameDirectorAppointmentEligibility;
    readonly readSnapshot?: () =>
        | TSnapshot
        | undefined
        | Promise<TSnapshot | undefined>;
    readonly autoSnapshotIntervalMs?: number | false;
    readonly onPresence?: RallarGameEnvelopeHandler<TPresence>;
    readonly onInput?: RallarGameEnvelopeHandler<TInput>;
    readonly onIntent?: RallarGameEnvelopeHandler<TIntent>;
    readonly onSnapshot?: RallarGameEnvelopeHandler<TSnapshot>;
    readonly onEvent?: RallarGameEnvelopeHandler<TEvent>;
    readonly onSyncRequest?: RallarGameEnvelopeHandler<object>;
}

export interface RallarGameMatchHandle<TInput, TIntent, TSnapshot, TEvent, TPresence = TInput> {
    start(): Promise<RallarGameMatchStatus>;
    stop(): void;
    status(): RallarGameMatchStatus;
    diagnostics(): RallarGameDiagnostics;
    canAppointDirector(): RallarGameDirectorAppointmentEligibility;
    reportCapability(
        capability?: Partial<RallarGameHostCapability>
    ): Promise<RallarGameSendResult>;
    election(): RallarGameHostElectionResult;
    appointIfElected(): Promise<RallarGameHostAppointResult>;
    waitForReadyLanes(
        options?: RallarGameLaneReadyOptions
    ): Promise<RallarGamePeerReadiness>;
    sendInput(input: TInput): Promise<RallarGameSendResult>;
    sendPresence(
        presence: TPresence,
        options?: RallarGamePresenceSendOptions
    ): Promise<RallarGameSendResult>;
    sendIntent(intent: TIntent): Promise<RallarGameSendResult>;
    publishSnapshot(
        snapshot: TSnapshot,
        options?: Readonly<{ reliable?: boolean; }>
    ): Promise<RallarGameSendResult>;
    publishEvent(event: TEvent): Promise<RallarGameSendResult>;
    requestSync(payload?: object): Promise<RallarGameSendResult>;
    onPresence(handler: RallarGameEnvelopeHandler<TPresence>): RallarUnsubscribe;
    onStatus(handler: RallarGameStatusHandler): RallarUnsubscribe;
}

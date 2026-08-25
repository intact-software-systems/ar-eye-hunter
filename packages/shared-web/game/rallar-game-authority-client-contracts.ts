import type { RallarFacade, RallarMessage, RallarUnsubscribe } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RallarGameAuthorityClientStatus,
    RallarGameAuthorityCommandResult,
    RallarGameAuthorityDiagnostics,
    RallarGameAuthorityEnvelope,
    RallarGameAuthorityEnvelopeHandler,
    RallarGameAuthorityRef,
    RallarGameAuthoritySendResult,
    RallarGameAuthorityStatusHandler,
    RallarGameAuthorityTypeIds
} from '@shared/rallar-game/mod.ts';

export type RallarGameAuthorityClientRallarFacade = Pick<
    RallarFacade,
    'session' | 'subscriptions' | 'rooms' | 'messages' | 'rtc'
>;

export interface RallarGameAuthorityPeerAssistOptions<TSnapshot> {
    readonly enabled?: boolean;
    readonly snapshotRepair?: boolean;
    readonly acceptSnapshotRepair?: (
        envelope: RallarGameAuthorityEnvelope<TSnapshot>,
        message: RallarMessage<RallarGameAuthorityEnvelope<TSnapshot>>
    ) => boolean | Promise<boolean>;
}

export interface RallarGameAuthorityClientConfig<TCommand, TSnapshot, TEvent, TPresence = never> {
    readonly rallar: RallarGameAuthorityClientRallarFacade;
    readonly protocol: string;
    readonly topicId: string;
    readonly authority: RallarGameAuthorityRef;
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly typeIds?: Partial<RallarGameAuthorityTypeIds>;
    readonly authorityTtlMs?: number;
    readonly peerAssist?: RallarGameAuthorityPeerAssistOptions<TSnapshot>;
    readonly onCommandResult?: RallarGameAuthorityEnvelopeHandler<RallarGameAuthorityCommandResult>;
    readonly onSnapshot?: RallarGameAuthorityEnvelopeHandler<TSnapshot>;
    readonly onEvent?: RallarGameAuthorityEnvelopeHandler<TEvent>;
    readonly onPresence?: RallarGameAuthorityEnvelopeHandler<TPresence>;
}

export interface RallarGameAuthorityCommandOptions {
    readonly key?: string;
}

export interface RallarGameAuthorityClientHandle<TCommand, TSnapshot, TEvent, TPresence = never> {
    start(): Promise<RallarGameAuthorityClientStatus>;
    stop(): void;
    status(): RallarGameAuthorityClientStatus;
    diagnostics(): RallarGameAuthorityDiagnostics;
    sendCommand(
        command: TCommand,
        options?: RallarGameAuthorityCommandOptions
    ): Promise<RallarGameAuthoritySendResult>;
    requestSync<TPayload>(payload?: TPayload): Promise<RallarGameAuthoritySendResult>;
    publishPresence(presence: TPresence): Promise<RallarGameAuthoritySendResult>;
    publishSnapshotRepair(snapshot: TSnapshot): Promise<RallarGameAuthoritySendResult>;
    onStatus(handler: RallarGameAuthorityStatusHandler): RallarUnsubscribe;
}

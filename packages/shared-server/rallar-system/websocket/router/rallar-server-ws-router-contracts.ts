import type { ALMessage, ALTargets } from '@shared/al-contracts/al-contract.ts';
import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundEnqueueStatus } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type {
    WsQueueBoxServerService,
    WsServerLiveSendFailure,
    WsServerResolvedRecipient
} from '@shared/services/WsQueueBoxServerService.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';

export type RallarServerWsFanout = 'live-only' | 'outbox' | 'none';

export type RallarServerWsPublishStatus =
    | 'sent-live'
    | 'queued-outbox'
    | 'none'
    | 'no-recipients'
    | 'partial-failure'
    | 'skipped'
    | 'duplicate'
    | 'superseded'
    | 'expired'
    | 'no-route'
    | 'rate-limited'
    | 'circuit-open'
    | 'failed';

export interface RallarServerWsPublishResult {
    readonly fanout: RallarServerWsFanout;
    readonly status: RallarServerWsPublishStatus;
    readonly message: ALMessage;
    readonly sentCount?: number;
    readonly recipientCount?: number;
    readonly failedCount?: number;
    readonly recipients?: readonly WsServerResolvedRecipient[];
    readonly failures?: readonly WsServerLiveSendFailure[];
    readonly entry?: ResourceEntry;
    readonly entries: readonly ResourceEntry[];
    readonly enqueueStatus?: ALOutboundEnqueueStatus;
    readonly reason?: string;
}

export type RallarServerWsTopicScope = 'app' | 'room' | 'world';

/**
 * Topic payload declarations may use ordinary object interfaces. Ingress still
 * proves the runtime value is exact JSON before any typed topic callback runs.
 */
export type RallarServerWsPayload = JsonWireValue | object;

export interface RallarServerWsSelector {
    readonly topicId?: string;
    readonly typeId?: string;
}

export interface RallarServerWsMessage<T extends RallarServerWsPayload = JsonWireValue> {
    readonly payload: T;
    readonly raw: ALMessage;
    readonly receivedAtEpochMs: number;
}

export type RallarServerWsValidator = (
    value: JsonWireValue,
    context: RallarServerWsMessageContext
) => boolean | Promise<boolean>;

export type RallarServerWsAuthorizer<T extends RallarServerWsPayload = JsonWireValue> = (
    message: RallarServerWsMessage<T>,
    context: RallarServerWsMessageContext
) => boolean | Promise<boolean>;

export interface RallarServerWsTopicMetadata {
    readonly topicId: string;
    readonly typeId?: string;
    readonly scope?: RallarServerWsTopicScope;
    readonly maxPayloadBytes?: number;
    readonly fanout?: RallarServerWsFanout;
}

export interface RallarServerWsRoomAuthorizationInput {
    readonly message: ALMessage;
    readonly definition?: RallarServerWsTopicMetadata;
    readonly roomId: string;
    readonly roomRef?: GroupRef;
    readonly senderId: string;
    readonly topicId: string;
    readonly typeId: string;
    readonly minSnapshotVersion?: number;
}

export type RallarServerWsRoomAuthorizationDecision =
    | boolean
    | Readonly<{ authorized: true; }>
    | Readonly<{
        authorized: false;
        reason?: ALNackReason;
        logMessage?: string;
        serverSnapshotVersion?: number;
    }>;

export type RallarServerWsRoomAuthorizer = (
    input: RallarServerWsRoomAuthorizationInput
) => RallarServerWsRoomAuthorizationDecision | Promise<RallarServerWsRoomAuthorizationDecision>;

export type RallarServerWsHandler<T extends RallarServerWsPayload = JsonWireValue> = (
    message: RallarServerWsMessage<T>,
    context: RallarServerWsMessageContext
) => void | Promise<void>;

export interface RallarServerWsTopicDefinition<T extends RallarServerWsPayload = JsonWireValue>
    extends RallarServerWsTopicMetadata {
    readonly topicId: string;
    readonly typeId?: string;
    readonly scope?: RallarServerWsTopicScope;
    readonly validate?: RallarServerWsValidator;
    readonly authorize?: RallarServerWsAuthorizer<T>;
    readonly maxPayloadBytes?: number;
    readonly fanout?: RallarServerWsFanout;
}

export interface RallarServerWsProxyRule<T extends RallarServerWsPayload = JsonWireValue> {
    readonly id?: string;
    readonly from: RallarServerWsSelector;
    readonly authorize?: RallarServerWsAuthorizer<T>;
    readonly transform?: (
        message: RallarServerWsMessage<T>,
        context: RallarServerWsMessageContext
    ) => ALMessage | Promise<ALMessage>;
    readonly targets?: (
        message: RallarServerWsMessage<T>,
        context: RallarServerWsMessageContext
    ) => ALTargets | Promise<ALTargets>;
    readonly fanout?: RallarServerWsFanout;
    readonly suppressDefaultFanout?: boolean;
}

export interface RallarServerWsRouterOptions {
    readonly maxPayloadBytes?: number;
    readonly sendNacks?: boolean;
    readonly allowImplicitUserTopics?: boolean;
    readonly defaultFanout?: RallarServerWsFanout;
    readonly authorizeRoomMessage?: RallarServerWsRoomAuthorizer;
    readonly wakeOutbox?: () => void;
}

export interface RallarServerWsMessageContext {
    readonly service: WsQueueBoxServerService;
    readonly definition?: RallarServerWsTopicMetadata;
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly senderId: string;
    readonly proxy: RallarServerWsProxyContext;
}

export interface RallarServerWsProxyContext {
    toTargets(
        message: ALMessage,
        fanout?: RallarServerWsFanout
    ): Promise<RallarServerWsPublishResult>;
    toPeer(
        peerId: string,
        message: ALMessage,
        fanout?: RallarServerWsFanout
    ): Promise<RallarServerWsPublishResult>;
    toRoom(
        roomId: string,
        message: ALMessage,
        options?: Readonly<{
            exceptPeerIds?: readonly string[];
            fanout?: RallarServerWsFanout;
        }>
    ): Promise<RallarServerWsPublishResult>;
    toAll(
        message: ALMessage,
        options?: Readonly<{
            exceptPeerIds?: readonly string[];
            fanout?: RallarServerWsFanout;
        }>
    ): Promise<RallarServerWsPublishResult>;
}

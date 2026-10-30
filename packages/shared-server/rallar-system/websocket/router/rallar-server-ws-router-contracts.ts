import type { ALMessage, ALTargets } from '@shared/al-contracts/al-contract.ts';
import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { Either } from '@shared/resilience/Either.ts';
import type {
    WsServerLiveSendFailure,
    WsServerResolvedRecipient
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { LiveWsNoticeTransport } from '../../queue-pubsub/live-ws-notice.ts';
import type { RoomPublicationAdmission } from '../room-publication/compute-room-publication-admission.ts';
import type { WsGrantedTopicSet } from '../room-publication/ws-granted-topic-set.ts';

export type RallarServerWsFanout = 'live-only' | 'outbox' | 'none';

export interface RallarServerWsPublishInputDto {
    readonly message: ALMessage;
    /** Required for a unicast that names no group and for a world broadcast; refused beside targets that name a group. */
    readonly scope?: StateScope;
    readonly fanout?: RallarServerWsFanout;
    /** The server producer publishing; a granted topic admits only the producers its definition lists (D496). */
    readonly producerId?: string;
}

/** A proxy's unicast publishes for its rule's sender, never as a server producer, so it names no `producerId`. */
export interface RallarServerWsUnicastInputDto extends Omit<RallarServerWsPublishInputDto, 'producerId'> {
    readonly scope: StateScope;
    readonly peerId: string;
}

export type RallarServerWsPublishStatus =
    | 'cluster-published'
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
    | 'failed'
    | 'refused';

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
    /** Undefined for a `live-only` or `none` fanout: only outbox admission ever produces a verdict. */
    readonly verdict?: ALDeliveryAdmissionVerdict;
    readonly reason?: string;
    /** Present exactly when the status is `refused`: the topic's publication policy refused the producer. */
    readonly refusal?: RoomPublicationAdmission.RefusalCode;
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

export interface RallarServerWsMessage<T extends RallarServerWsPayload> {
    readonly payload: T;
    readonly raw: ALMessage;
    readonly receivedAtEpochMs: number;
}

export type RallarServerWsValidator = (
    value: JsonWireValue,
    context: RallarServerWsMessageContext
) => boolean | Promise<boolean>;

export type RallarServerWsAuthorizer<T extends RallarServerWsPayload> = (
    message: RallarServerWsMessage<T>,
    context: RallarServerWsMessageContext
) => boolean | Promise<boolean>;

/**
 * Who a topic's room publications reach: every live session of the room's active members, or only the sessions of
 * the principals a publication grant names, published only by grant holders and the listed server producers (D486).
 */
export type RallarServerWsTopicAccess =
    | Readonly<{ participation: 'members'; }>
    | Readonly<{ participation: 'granted'; serverProducerIds: readonly string[]; }>;

export type RallarServerWsTopicMetadata =
    & Readonly<{
        topicId: string;
        typeId?: string;
        scope?: RallarServerWsTopicScope;
        maxPayloadBytes?: number;
        fanout?: RallarServerWsFanout;
    }>
    & RallarServerWsTopicAccess;

export interface RallarServerWsRoomAuthorizationInput {
    readonly message: ALMessage;
    readonly definition?: RallarServerWsTopicMetadata;
    /** The access of the message's topic, read from the router's registry: `members` for an implicit topic. */
    readonly topic: RallarServerWsTopicAccess;
    readonly roomId: string;
    readonly roomRef?: GroupRef;
    readonly senderId: string;
    readonly topicId: string;
    readonly typeId: string;
    readonly minSnapshotVersion?: number;
    /** The sender's roster stamp; absent when it stamped none, and no roster floor applies. */
    readonly rosterVersion?: number;
}

export interface RallarServerWsRoomAudience {
    readonly targets: ALTargets;
    readonly sessions: readonly GroupPresenceSession[];
    /** The snapshot version the sessions were read at. */
    readonly snapshotVersion: number;
}

export interface RallarServerWsRoomAuthorizationDenied {
    readonly authorized: false;
    readonly reason?: ALNackReason;
    readonly logMessage?: string;
    readonly serverSnapshotVersion?: number;
}

export interface RallarServerWsRoomAuthorizationAllowed {
    readonly authorized: true;
    /** Absent only for generic authorizers whose target resolver owns the audience. */
    readonly audience?: RallarServerWsRoomAudience;
}

export type RallarServerWsRoomAuthorizationDecision =
    | boolean
    | RallarServerWsRoomAuthorizationAllowed
    | RallarServerWsRoomAuthorizationDenied;

export type RallarServerWsRoomAuthorizer = (
    input: RallarServerWsRoomAuthorizationInput
) => RallarServerWsRoomAuthorizationDecision | Promise<RallarServerWsRoomAuthorizationDecision>;

export interface RallarServerWsPublishAudienceInputDto {
    readonly message: ALMessage;
    readonly topic: RallarServerWsTopicAccess;
    readonly producerId: string | undefined;
}

/**
 * The room sessions a server-originated publish freezes as its audience, or the topic policy's refusal of its producer;
 * undefined when there is no room to read.
 */
export type RallarServerWsPublishAudienceReader = (
    input: RallarServerWsPublishAudienceInputDto
) => Promise<Either<RoomPublicationAdmission.Refusal, RallarServerWsRoomAudience> | undefined>;

export type RallarServerWsHandler<T extends RallarServerWsPayload> = (
    message: RallarServerWsMessage<T>,
    context: RallarServerWsMessageContext
) => void | Promise<void>;

export type RallarServerWsTopicDefinition<T extends RallarServerWsPayload> =
    & RallarServerWsTopicMetadata
    & Readonly<{
        validate?: RallarServerWsValidator;
        authorize?: RallarServerWsAuthorizer<T>;
    }>;

export interface RallarServerWsProxyRule<T extends RallarServerWsPayload> {
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
    readonly readServerPublishAudience?: RallarServerWsPublishAudienceReader;
    /** The composition root's set, shared with the target resolver; one with no granted topic passes a new set. */
    readonly grantedTopics: WsGrantedTopicSet;
    readonly wakeOutbox?: () => void;
    readonly nowEpochMs?: () => number;
    readonly livePublication?: {
        readonly transport: LiveWsNoticeTransport;
        readonly channel: string;
        readonly publisherId: string;
        readonly readPrincipalSessionIds?: (
            principalRef: ClientPrincipalRef
        ) => Promise<readonly string[] | undefined>;
    };
}

export interface RallarServerWsMessageContext {
    readonly service: WsQueueBoxServerService;
    readonly definition?: RallarServerWsTopicMetadata;
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly senderId: string;
    readonly authenticatedScope: StateScope | undefined;
    readonly proxy: RallarServerWsProxyContext;
}

export interface RallarServerWsProxyContext {
    toTargets(
        message: ALMessage,
        fanout?: RallarServerWsFanout
    ): Promise<RallarServerWsPublishResult>;
    toPeer(
        input: RallarServerWsUnicastInputDto
    ): Promise<RallarServerWsPublishResult>;
    toRoom(
        roomRef: GroupRef,
        message: ALMessage,
        options?: RallarServerWsBroadcastOptions
    ): Promise<RallarServerWsPublishResult>;
    toAll(
        message: ALMessage,
        options?: RallarServerWsBroadcastOptions
    ): Promise<RallarServerWsPublishResult>;
}

export interface RallarServerWsBroadcastOptions {
    readonly exceptPeerIds?: readonly string[];
    readonly fanout?: RallarServerWsFanout;
}

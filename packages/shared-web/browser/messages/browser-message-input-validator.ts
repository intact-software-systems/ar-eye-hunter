import type {
    RallarMessageScope,
    RallarMessageSendBase,
    RallarMessageTransport,
    RallarRoomAudienceInput,
    RallarRtcSendInput,
    RallarTypedMessageChannelDefinition,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { validateRallarTypedChannelPolicy } from '@shared-web/browser/messages/validate-rallar-typed-channel-policy.ts';
import type { ALAckMode } from '@shared/al-contracts/al-contract.ts';
import { assertPersistedALQos } from '@shared/al-contracts/al-message-persistence/assert-persisted-al-qos.ts';
import { decodePersistedALRecord } from '@shared/al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import type { ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    validateRallarGroupRef,
    validateRallarJsonPayload,
    validateRallarNonNegativeInteger,
    validateRallarRouteId,
    validateRallarWsUserTopicId,
    type RallarJsonPayloadValidationResult,
    type RallarValidationIssue
} from '@shared/api/rallar-validation.ts';
import { toError } from '@shared/resilience/to-error.ts';

export interface ResolvedWsMessageInput<T> {
    readonly input: RallarWsSendInput<T>;
    readonly scope: RallarMessageScope;
    readonly roomId: string | undefined;
    readonly roomRef: GroupRef | undefined;
}

interface PushOptionalRouteIdIssueInput {
    readonly value: string | undefined;
    readonly path: string;
    readonly label: string;
    readonly issues: RallarValidationIssue[];
}

interface RoomMessageIdentity {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
}

export namespace BrowserMessageInputValidator {
    export interface Input {
        readonly readMaxPayloadBytes: () => number;
    }
}

export class BrowserMessageInputValidator {
    private readonly input: BrowserMessageInputValidator.Input;

    public constructor(input: BrowserMessageInputValidator.Input) {
        this.input = input;
    }

    public readPayloadValidation<T>(payload: T): RallarJsonPayloadValidationResult {
        const validation = validateRallarJsonPayload(payload, {
            path: '$.payload',
            maxBytes: this.input.readMaxPayloadBytes()
        });
        return validation;
    }

    public validateRtc<T>(
        input: RallarRtcSendInput<T>,
        roomId: string | undefined
    ): readonly RallarValidationIssue[] {
        const issues: RallarValidationIssue[] = [];
        this.pushBaseIssues(input, 'rtc', issues);
        this.pushOptionalRouteId({
            value: input.roomId,
            path: '$.roomId',
            label: 'Room ID',
            issues
        });
        this.pushOptionalGroupRef(input.roomRef, '$.roomRef', issues);
        this.pushRtcRouteIssues(input, issues);
        this.pushRtcSequenceIssues(input, issues);
        this.pushRoomIdentityIssue(input, issues);
        this.pushScopeIssue(input.scope ?? 'room', 'RTC', issues);
        this.pushAudienceIssues(input, input.scope ?? 'room', issues);
        issues.push(...validateLeaderAudience(input.ack, input.scope ?? 'room'));
        if (roomId !== undefined) {
            this.pushOptionalRouteId({
                value: roomId,
                path: '$.roomId',
                label: 'Room ID',
                issues
            });
        }
        return issues;
    }

    public validateWs<T>(resolved: ResolvedWsMessageInput<T>): readonly RallarValidationIssue[] {
        const { input, scope, roomId, roomRef } = resolved;
        const issues: RallarValidationIssue[] = [];
        this.pushBaseIssues(input, 'ws', issues);
        this.pushOptionalRouteId({
            value: input.roomId,
            path: '$.roomId',
            label: 'Room ID',
            issues
        });
        this.pushOptionalGroupRef(input.roomRef, '$.roomRef', issues);
        this.pushOptionalNonNegativeInteger(input.minSnapshotVersion, '$.minSnapshotVersion', issues);
        this.pushWsScopeIssues(resolved, issues);
        if (scope === 'room' || scope === 'principal') {
            this.pushWsRoomIssues(roomId, roomRef, issues);
        }
        this.pushAudienceIssues(input, scope, issues);
        issues.push(...validateLeaderAudience(input.ack, scope));
        return issues;
    }

    /** A broadcast has no group track to default its ordering key from, so a WS send states both halves or neither. */
    public validateWsOrdering<T>(input: RallarWsSendInput<T>): readonly RallarValidationIssue[] {
        const issues: RallarValidationIssue[] = [];
        this.pushOptionalRouteId({
            value: input.orderingKey,
            path: '$.orderingKey',
            label: 'Ordering key',
            issues
        });
        this.pushOptionalNonNegativeInteger(input.seq, '$.seq', issues);
        if (input.seq !== undefined && input.orderingKey === undefined) {
            issues.push({
                path: '$.orderingKey',
                code: 'missing-ordering-key',
                message: 'An ordered WS send states its orderingKey beside its seq.'
            });
        }
        if (input.orderingKey !== undefined && input.seq === undefined) {
            issues.push({
                path: '$.seq',
                code: 'missing-seq',
                message: 'An ordered WS send states its seq beside its orderingKey.'
            });
        }
        return issues;
    }

    public validateResolvedRoomRef(roomRef: GroupRef, path: string): readonly RallarValidationIssue[] {
        return validateRallarGroupRef(roomRef, path).issues;
    }

    public validateTypedChannel(definition: RallarTypedMessageChannelDefinition): readonly RallarValidationIssue[] {
        const issues: RallarValidationIssue[] = [];
        this.pushOptionalRouteId({
            value: definition.topicId,
            path: '$.topicId',
            label: 'Topic ID',
            issues
        });
        issues.push(...validateRallarRouteId(definition.typeId, '$.typeId', 'Type ID').issues);
        issues.push(...validateRallarTypedChannelPolicy(definition));
        return issues;
    }

    public validateRoomChannel(input: RoomMessageIdentity): readonly RallarValidationIssue[] {
        const issues: RallarValidationIssue[] = [];
        this.pushOptionalRouteId({
            value: input.roomId,
            path: '$.roomId',
            label: 'Room ID',
            issues
        });
        this.pushOptionalGroupRef(input.roomRef, '$.roomRef', issues);
        this.pushRoomIdentityIssue(input, issues);
        return issues;
    }

    private pushRtcRouteIssues<T>(
        input: RallarRtcSendInput<T>,
        issues: RallarValidationIssue[]
    ): void {
        this.pushOptionalRouteId({
            value: input.orderingKey,
            path: '$.orderingKey',
            label: 'Ordering key',
            issues
        });
        this.pushOptionalRouteId({
            value: input.overlayId,
            path: '$.overlayId',
            label: 'Overlay ID',
            issues
        });
        input.nextHopPeerIds?.forEach((peerId, index) =>
            this.pushOptionalRouteId({
                value: peerId,
                path: `$.nextHopPeerIds[${index}]`,
                label: 'Peer ID',
                issues
            })
        );
    }

    private pushRtcSequenceIssues<T>(
        input: RallarRtcSendInput<T>,
        issues: RallarValidationIssue[]
    ): void {
        this.pushOptionalNonNegativeInteger(input.minSnapshotVersion, '$.minSnapshotVersion', issues);
        this.pushOptionalNonNegativeInteger(input.seq, '$.seq', issues);
        this.pushOptionalNonNegativeInteger(input.fanoutLimit, '$.fanoutLimit', issues);
    }

    private pushBaseIssues<T>(
        input: RallarMessageSendBase<T>,
        transport: RallarMessageTransport,
        issues: RallarValidationIssue[]
    ): void {
        issues.push(...validateTopic(input, transport));
        issues.push(...validateRallarRouteId(input.typeId, '$.typeId', 'Type ID').issues);
        this.pushOptionalRouteId({
            value: input.contextId,
            path: '$.contextId',
            label: 'Context ID',
            issues
        });
        this.pushOptionalRouteId({
            value: input.resourceId,
            path: '$.resourceId',
            label: 'Resource ID',
            issues
        });
        this.pushOptionalNonNegativeInteger(input.ttlHops, '$.ttlHops', issues);
        this.pushOptionalNonNegativeInteger(input.ttlMs, '$.ttlMs', issues);
        issues.push(...validateQosRequest(input.qos));
    }

    /** A `room.` topic is room-scoped by its name, so the server refuses a world send on it as malformed. */
    private pushWsScopeIssues<T>(
        resolved: ResolvedWsMessageInput<T>,
        issues: RallarValidationIssue[]
    ): void {
        this.pushScopeIssue(resolved.scope, 'WS', issues);
        this.pushRoomIdentityIssue(resolved.input, issues);
        if (resolved.scope === 'world' && (resolved.input.topicId ?? resolved.input.typeId).startsWith('room.')) {
            issues.push({
                path: '$.topicId',
                code: 'world-on-room-topic',
                message: 'A world-scoped send takes a topic outside room.'
            });
        }
    }

    private pushScopeIssue(scope: RallarMessageScope, carrier: 'RTC' | 'WS', issues: RallarValidationIssue[]): void {
        if (!['room', 'world', 'principal'].includes(scope)) {
            issues.push({
                path: '$.scope',
                code: 'invalid-scope',
                message: `${carrier} scope must be room, world, or principal.`
            });
        }
    }

    private pushWsRoomIssues(
        roomId: string | undefined,
        roomRef: GroupRef | undefined,
        issues: RallarValidationIssue[]
    ): void {
        if (!roomId) {
            issues.push({
                path: '$.roomId',
                code: 'missing-room',
                message: 'Room-scoped WS messages require a roomId or roomRef.'
            });
        }
        if (!roomRef) {
            issues.push({
                path: '$.roomRef',
                code: 'missing-room-ref',
                message: 'Room-scoped WS messages require a scoped roomRef.'
            });
            return;
        }
        this.pushOptionalGroupRef(roomRef, '$.roomRef', issues);
    }

    /** A principal send names its principal, a fixed list rides a room send, and every named session is a route id. */
    private pushAudienceIssues(
        audience: Omit<RallarRoomAudienceInput, 'scope'>,
        scope: RallarMessageScope,
        issues: RallarValidationIssue[]
    ): void {
        if (scope === 'principal' && audience.principalId === undefined) {
            issues.push({
                path: '$.principalId',
                code: 'missing-principal-id',
                message: 'A principal-scoped send names its principalId.'
            });
        }
        if (audience.principalId !== undefined && scope !== 'principal') {
            issues.push({
                path: '$.principalId',
                code: 'principal-scope-required',
                message: 'A principalId is sent with scope principal.'
            });
        }
        this.pushOptionalRouteId({ value: audience.principalId, path: '$.principalId', label: 'Principal ID', issues });
        audience.exceptPeerIds?.forEach((peerId, index) =>
            this.pushOptionalRouteId({ value: peerId, path: `$.exceptPeerIds[${index}]`, label: 'Peer ID', issues })
        );
        if (audience.recipientPeerIds !== undefined) {
            this.pushFixedAudienceIssues(audience.recipientPeerIds, scope, issues);
        }
    }

    private pushFixedAudienceIssues(
        recipientPeerIds: readonly string[],
        scope: RallarMessageScope,
        issues: RallarValidationIssue[]
    ): void {
        if (scope !== 'room') {
            issues.push({
                path: '$.recipientPeerIds',
                code: 'fixed-audience-requires-room-scope',
                message: 'A fixed recipient list is sent with room scope.'
            });
        }
        if (
            recipientPeerIds.length === 0 || recipientPeerIds.length > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries ||
            new Set(recipientPeerIds).size !== recipientPeerIds.length
        ) {
            issues.push({
                path: '$.recipientPeerIds',
                code: 'invalid-fixed-audience',
                message:
                    `A fixed recipient list names 1 to ${AL_MESSAGE_RESOURCE_LIMITS.collectionEntries} distinct session ids.`
            });
        }
        recipientPeerIds.forEach((peerId, index) =>
            this.pushOptionalRouteId({ value: peerId, path: `$.recipientPeerIds[${index}]`, label: 'Peer ID', issues })
        );
    }

    private pushRoomIdentityIssue(
        input: RoomMessageIdentity,
        issues: RallarValidationIssue[]
    ): void {
        if (input.roomId && input.roomRef && input.roomId !== input.roomRef.groupId) {
            issues.push({
                path: '$.roomRef.groupId',
                code: 'room-id-mismatch',
                message: 'roomId must match roomRef.groupId.'
            });
        }
    }

    private pushOptionalRouteId(input: PushOptionalRouteIdIssueInput): void {
        if (input.value !== undefined) {
            input.issues.push(
                ...validateRallarRouteId(input.value, input.path, input.label).issues
            );
        }
    }

    private pushOptionalGroupRef(
        value: GroupRef | undefined,
        path: string,
        issues: RallarValidationIssue[]
    ): void {
        if (value !== undefined) {
            issues.push(...validateRallarGroupRef(value, path).issues);
        }
    }

    private pushOptionalNonNegativeInteger(
        value: number | undefined,
        path: string,
        issues: RallarValidationIssue[]
    ): void {
        if (value !== undefined) {
            issues.push(...validateRallarNonNegativeInteger(value, path).issues);
        }
    }
}

function validateTopic<T>(
    input: RallarMessageSendBase<T>,
    transport: RallarMessageTransport
): readonly RallarValidationIssue[] {
    return transport === 'ws'
        ? validateRallarWsUserTopicId(input.topicId ?? input.typeId, '$.topicId').issues
        : validateRallarRouteId(
            input.topicId ?? input.typeId,
            '$.topicId',
            'Topic ID'
        ).issues;
}

/** The request travels inside the envelope, so it passes the check every persisted envelope's QoS passes. */
function validateQosRequest(qos: ALQosPolicyRequest | undefined): readonly RallarValidationIssue[] {
    if (qos === undefined) {
        return [];
    }
    try {
        assertPersistedALQos(decodePersistedALRecord(JSON.stringify(qos), 'qos'));
        return [];
    }
    catch (error) {
        return [{ path: '$.qos', code: 'invalid-qos', message: toError(error).message }];
    }
}

/** A `group-leader` send addresses its room's leader, so it names a room audience: never the world (D166). */
function validateLeaderAudience(
    ack: ALAckMode | undefined,
    scope: RallarMessageScope
): readonly RallarValidationIssue[] {
    return ack === 'group-leader' && scope === 'world'
        ? [{
            path: '$.ack',
            code: 'leader-requires-room-audience',
            message: 'A group-leader send addresses its room\'s leader: it names a room audience, never the world.'
        }]
        : [];
}

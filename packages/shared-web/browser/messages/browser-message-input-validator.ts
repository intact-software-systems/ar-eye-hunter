import type {
    RallarMessageSendBase,
    RallarMessageTransport,
    RallarRtcSendInput,
    RallarWsSendInput
} from '@shared-web/browser/rallar-message-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    throwRallarValidation,
    validateRallarGroupRef,
    validateRallarJsonPayload,
    validateRallarNonNegativeInteger,
    validateRallarRouteId,
    validateRallarWsUserTopicId,
    type RallarValidationIssue
} from '@shared/api/rallar-validation.ts';

export interface ResolvedWsMessageInput<T> {
    readonly input: RallarWsSendInput<T>;
    readonly scope: 'room' | 'world' | 'all';
    readonly roomId: string | undefined;
    readonly roomRef: GroupRef | undefined;
}

interface BrowserMessageInputValidatorInput {
    readonly readMaxPayloadBytes: () => number;
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

export class BrowserMessageInputValidator {
    private readonly input: BrowserMessageInputValidatorInput;

    public constructor(input: BrowserMessageInputValidatorInput) {
        this.input = input;
    }

    public assertRtc<T>(
        input: RallarRtcSendInput<T>,
        roomId: string | undefined
    ): void {
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
        if (roomId !== undefined) {
            this.pushOptionalRouteId({
                value: roomId,
                path: '$.roomId',
                label: 'Room ID',
                issues
            });
        }
        this.throwIfIssues(issues);
    }

    public assertWs<T>(resolved: ResolvedWsMessageInput<T>): void {
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
        input.exceptPeerIds?.forEach((peerId, index) =>
            this.pushOptionalRouteId({
                value: peerId,
                path: `$.exceptPeerIds[${index}]`,
                label: 'Peer ID',
                issues
            })
        );
        this.pushOptionalNonNegativeInteger(input.minSnapshotVersion, '$.minSnapshotVersion', issues);
        this.pushWsScopeIssues(resolved, issues);
        if (scope === 'room') {
            this.pushWsRoomIssues(roomId, roomRef, issues);
        }
        this.throwIfIssues(issues);
    }

    public assertResolvedRoomRef(roomRef: GroupRef, path: string): void {
        this.throwIfIssues(validateRallarGroupRef(roomRef, path).issues);
    }

    public assertTypedChannel(topicId: string | undefined, typeId: string): void {
        const issues: RallarValidationIssue[] = [];
        this.pushOptionalRouteId({
            value: topicId,
            path: '$.topicId',
            label: 'Topic ID',
            issues
        });
        issues.push(...validateRallarRouteId(typeId, '$.typeId', 'Type ID').issues);
        this.throwIfIssues(issues);
    }

    public assertRoomChannel(input: RoomMessageIdentity): void {
        const issues: RallarValidationIssue[] = [];
        this.pushOptionalRouteId({
            value: input.roomId,
            path: '$.roomId',
            label: 'Room ID',
            issues
        });
        this.pushOptionalGroupRef(input.roomRef, '$.roomRef', issues);
        this.pushRoomIdentityIssue(input, issues);
        this.throwIfIssues(issues);
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
        this.pushOptionalNonNegativeInteger(input.membershipEpoch, '$.membershipEpoch', issues);
        this.pushOptionalNonNegativeInteger(input.minSnapshotVersion, '$.minSnapshotVersion', issues);
        this.pushOptionalNonNegativeInteger(input.seq, '$.seq', issues);
        this.pushOptionalNonNegativeInteger(input.fanoutLimit, '$.fanoutLimit', issues);
    }

    private pushBaseIssues<T>(
        input: RallarMessageSendBase<T>,
        transport: RallarMessageTransport,
        issues: RallarValidationIssue[]
    ): void {
        issues.push(...toTopicIssues(input, transport));
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
        issues.push(
            ...validateRallarJsonPayload(input.payload, {
                path: '$.payload',
                maxBytes: this.input.readMaxPayloadBytes()
            }).issues
        );
    }

    private pushWsScopeIssues<T>(
        resolved: ResolvedWsMessageInput<T>,
        issues: RallarValidationIssue[]
    ): void {
        if (!['room', 'world', 'all'].includes(resolved.scope)) {
            issues.push({
                path: '$.scope',
                code: 'invalid-scope',
                message: 'WS scope must be room, world, or all.'
            });
        }
        this.pushRoomIdentityIssue(resolved.input, issues);
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

    private throwIfIssues(issues: readonly RallarValidationIssue[]): void {
        if (issues.length > 0) {
            throwRallarValidation(issues);
        }
    }
}

function toTopicIssues<T>(
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

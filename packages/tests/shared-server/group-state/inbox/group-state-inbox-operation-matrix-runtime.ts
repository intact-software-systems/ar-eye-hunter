import { expect } from 'vitest';

import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { isAuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import {
    type GroupInviteCreateAppInboxPayload,
    type GroupMemberBanAppInboxPayload,
    type GroupMemberUnbanAppInboxPayload
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';

import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

import { processAuthenticated, SCOPE, type AuthorityHarness } from './group-state-inbox-test-runtime.ts';

export interface OperationMatrixCase {
    readonly type: AppInboxType;
    readonly operation: string;
    readonly authority: IssuedAuthSession;
    readonly data: JsonWireValue;
    assertDomain(): Promise<void>;
}

export function createInviteOperationCase(
    input: Readonly<{
        harness: AuthorityHarness;
        groupId: string;
        ownerActor: Readonly<{
            actorPrincipalId: string;
            actorSessionId: string;
        }>;
        requestId: string;
        assertDomain: () => Promise<void>;
    }>
): OperationMatrixCase {
    return {
        type: AppInboxType.GROUP_INVITE_CREATE,
        operation: 'createGroupInvite',
        authority: input.harness.sessions.owner,
        data: {
            scope: SCOPE,
            groupId: input.groupId,
            principalId: 'charlie',
            request: {
                invitationExpiresAtEpochMs: input.harness.nowEpochMs + 60_000,
                ...input.ownerActor,
                requestId: input.requestId
            }
        } satisfies GroupInviteCreateAppInboxPayload,
        assertDomain: input.assertDomain
    };
}

export function createGovernedOperationCase(
    input: Readonly<{
        harness: AuthorityHarness;
        groupId: string;
        ownerActor: Readonly<{
            actorPrincipalId: string;
            actorSessionId: string;
        }>;
        type: typeof AppInboxType.GROUP_MEMBER_BAN | typeof AppInboxType.GROUP_MEMBER_UNBAN;
        operation: 'banGroupMember' | 'unbanGroupMember';
        requestId: string;
        status: 'banned' | 'left';
    }>
): OperationMatrixCase {
    return {
        type: input.type,
        operation: input.operation,
        authority: input.harness.sessions.owner,
        data: {
            scope: SCOPE,
            groupId: input.groupId,
            principalId: 'charlie',
            request: { ...input.ownerActor, requestId: input.requestId }
        } satisfies GroupMemberBanAppInboxPayload | GroupMemberUnbanAppInboxPayload,
        assertDomain: async () => {
            expect(
                (
                    await input.harness.repository.readSnapshot({
                        ...SCOPE,
                        groupId: input.groupId
                    })
                )?.members.find((member) => member.principalId === 'charlie')
            ).toMatchObject({ status: input.status });
        }
    };
}

export async function readMatrixMember(
    harness: AuthorityHarness,
    groupId: string,
    principalId: string
) {
    const snapshot = await harness.repository.readSnapshot({ ...SCOPE, groupId });
    return snapshot?.members.find((member) => member.principalId === principalId);
}

export async function readMatrixPresenceSession(
    harness: AuthorityHarness,
    groupId: string,
    sessionId: string
) {
    return await harness.repository.findPresenceSession({ ...SCOPE, groupId, sessionId });
}

export async function runOperationMatrix(
    harness: AuthorityHarness,
    groupId: string,
    cases: readonly OperationMatrixCase[]
): Promise<void> {
    for (const testCase of cases) {
        const previousOutboxCount = harness.database.outboxEntries.size;
        const requestId = requireOperationMatrixRequestId(testCase.data);
        const caseGroupId = readOperationMatrixGroupId(testCase.data) ?? groupId;
        const enqueue = {
            type: testCase.type,
            resourceId: requestId,
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${caseGroupId}`,
            senderId: testCase.authority.clientId,
            data: testCase.data
        };
        if (!isAuthenticatedGroupMutationEnqueue(enqueue)) {
            throw new TypeError(`Authenticated group mutation type is required: ${testCase.type}`);
        }
        const result = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: testCase.authority,
            input: enqueue
        });

        expect(
            result.right,
            `${testCase.operation} result: ${result.left ? JSON.stringify(result.left) : ''}`
        ).toBeDefined();
        expect(harness.database.outboxEntries.size).toBe(previousOutboxCount + 1);
        expect(
            (await harness.queueEntries()).some(
                (entry) => entry.status === EntityStatus.COMPLETED && entry.dequeueAudit.attempts === 1
            )
        ).toBe(true);
        await testCase.assertDomain();
    }
}

function requireOperationMatrixRequestId(data: JsonWireValue): string {
    if (!data || typeof data !== 'object' || !('request' in data)) {
        throw new TypeError('Operation matrix data requires a request');
    }
    const request = data.request;
    if (!request || typeof request !== 'object' || !('requestId' in request)) {
        throw new TypeError('Operation matrix request requires requestId');
    }
    if (typeof request.requestId !== 'string' || request.requestId.length === 0) {
        throw new TypeError('Operation matrix requestId must be a non-empty string');
    }
    return request.requestId;
}

function readOperationMatrixGroupId(data: JsonWireValue): string | undefined {
    if (!isJsonWireObject(data)) {
        return undefined;
    }
    if (typeof data.groupId === 'string') {
        return data.groupId;
    }
    const request = data.request;
    if (!isJsonWireObject(request)) {
        return undefined;
    }
    return typeof request.groupId === 'string' ? request.groupId : undefined;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

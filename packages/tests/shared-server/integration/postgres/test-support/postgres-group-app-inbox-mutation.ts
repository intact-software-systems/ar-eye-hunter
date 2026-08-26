import type { StateScope } from '@shared/api/state-types.ts';
import type { Either } from '@shared/resilience/Either.ts';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import {
    isAuthenticatedGroupMutationEnqueue,
    type AuthenticatedGroupMutationEnqueue
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type { GroupStateInboxDurableResult } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';
import { toGroupMutationDescriptor } from '@shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts';
import { toScopedGroupMutationCommandId } from '@shared-server/rallar-system/group-state/scoped-group-mutation-command-id.ts';
import type { JsonWireObject } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

import type { PostgresAppInboxWorkerRuntime } from './postgres-app-inbox-worker-runtime.ts';

export type AuthenticatedGroupAppInboxData =
    & JsonWireObject
    & Readonly<{
        scope: StateScope;
        groupId: string;
        request: JsonWireObject & Readonly<{ requestId: string; }>;
    }>;

export interface GroupAppInboxMutationInput {
    readonly runtime: PostgresAppInboxWorkerRuntime;
    readonly authority: IssuedAuthSession;
    readonly type: AppInboxType;
    readonly data: AuthenticatedGroupAppInboxData;
}

export function createPostgresAppInboxTestAuthority(
    principalId: string,
    sessionId: string
): IssuedAuthSession {
    return {
        clientId: principalId,
        accessToken: `${sessionId}-postgres-worker-token`,
        username: principalId,
        sessionId,
        issuedAtEpochMs: 0,
        expiresAtEpochMs: 4_102_444_800_000
    };
}

export function groupAppInboxStart(
    input: GroupAppInboxMutationInput
): () => Promise<Either<AppInboxFailure, GroupStateInboxDurableResult>> {
    const enqueue = toAuthenticatedGroupAppInboxEnqueue(input);
    return () => input.runtime.group.processAuthenticatedGroupEntryUntilCompletion(enqueue, input.authority);
}

export async function toGroupAppInboxStorageCommandId(
    enqueue: AuthenticatedGroupMutationEnqueue,
    callerPrincipalId: string
): Promise<string> {
    return await toScopedGroupMutationCommandId(
        toGroupMutationDescriptor(enqueue),
        callerPrincipalId
    );
}

export function toAuthenticatedGroupAppInboxEnqueue(
    input: Pick<GroupAppInboxMutationInput, 'authority' | 'data' | 'type'>
): AuthenticatedGroupMutationEnqueue {
    const enqueue = {
        type: input.type,
        resourceId: input.data.request.requestId,
        contextId: [input.data.scope.applicationId, input.data.scope.workspaceId, input.data.groupId]
            .map(encodeURIComponent)
            .join(':'),
        senderId: input.authority.clientId,
        data: input.data
    };
    if (!isAuthenticatedGroupMutationEnqueue(enqueue)) {
        throw new TypeError(`Authenticated group mutation type is required: ${input.type}`);
    }
    return enqueue;
}

export async function runGroupAppInbox(
    input: GroupAppInboxMutationInput
): Promise<GroupStateInboxDurableResult> {
    return unwrapAppInboxResult(await input.runtime.runUntilCompletion(groupAppInboxStart(input)));
}

export function unwrapAppInboxResult<R>(result: Either<AppInboxFailure, R>): R {
    return result.fold(
        (error) => {
            throw new Error(error.message);
        },
        (value) => value
    );
}

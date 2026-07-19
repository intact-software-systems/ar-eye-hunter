import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import {
    createGroupStateRuntime,
    type GroupMutationAuthority,
    type GroupStateRuntime,
    type GroupStateService,
    type GroupStateServiceDependencies,
} from '@shared-server/rallar-system/services/group-state-service.ts';

export type TestAuthenticatedGroupStateService = {
    [K in keyof GroupStateService]: GroupStateService[K] extends (
        ...args: [...infer Inputs, GroupMutationAuthority]
    ) => infer Result
        ? (...args: Inputs) => Result
        : GroupStateService[K];
};

export type TestGroupStateRuntime = Readonly<{
    service: TestAuthenticatedGroupStateService;
    durable: GroupStateService;
    maintenance: GroupStateRuntime['maintenance'];
}>;

export function createTestGroupStateRuntime(
    dependencies: Omit<GroupStateServiceDependencies, 'authSessionRepository'>,
): TestGroupStateRuntime {
    const issued = new Map<string, IssuedAuthSession>();
    const runtime = createGroupStateRuntime({
        ...dependencies,
        authSessionRepository: {
            findBySessionId: (sessionId) => Promise.resolve(issued.get(sessionId)),
        },
    });
    const service = new Proxy(runtime.service, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== 'function' || !USER_MUTATIONS.has(String(property))) {
                return value;
            }
            return (...args: unknown[]) => {
                const request = args.at(-1) as Record<string, unknown>;
                const principalId = String(
                    request.actorPrincipalId ??
                    request.createdByPrincipalId ??
                    request.principalId ??
                    'alice',
                );
                const sessionId = PRESENCE_MUTATIONS.has(String(property))
                    ? String(args[2])
                    : String(request.actorSessionId ?? `${principalId}-session`);
                const authority = createTestAuthSession(principalId, sessionId);
                issued.set(sessionId, authority);
                return Reflect.apply(value, target, [...args, authority]);
            };
        },
    }) as TestAuthenticatedGroupStateService;
    return { service, durable: runtime.service, maintenance: runtime.maintenance };
}

export function createTestGroupStateService(
    dependencies: Omit<GroupStateServiceDependencies, 'authSessionRepository'>,
): TestAuthenticatedGroupStateService {
    return createTestGroupStateRuntime(dependencies).service;
}

export function createTestAuthSession(
    principalId: string,
    sessionId: string = `${principalId}-session`,
): IssuedAuthSession {
    return {
        clientId: principalId,
        sessionId,
        accessToken: `test-token:${principalId}:${sessionId}`,
        username: principalId,
        issuedAtEpochMs: 1,
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
    };
}

const USER_MUTATIONS = new Set([
    'createGroup', 'updateGroup', 'appointDirector', 'joinGroup',
    'createGroupInvite', 'revokeGroupInvite', 'acceptGroupInvite',
    'rotateGroupJoinCode', 'removeGroupMember', 'banGroupMember',
    'unbanGroupMember', 'setGroupMemberRole', 'transferGroupOwnership',
    'upsertMember', 'connectPresenceSession', 'connectPresenceSessionReceipt',
    'heartbeatPresenceSession', 'heartbeatPresenceSessionReceipt',
    'disconnectPresenceSession', 'disconnectPresenceSessionReceipt',
]);

const PRESENCE_MUTATIONS = new Set([
    'connectPresenceSession', 'connectPresenceSessionReceipt',
    'heartbeatPresenceSession', 'heartbeatPresenceSessionReceipt',
    'disconnectPresenceSession', 'disconnectPresenceSessionReceipt',
]);

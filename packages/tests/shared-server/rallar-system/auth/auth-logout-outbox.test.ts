import { Temporal } from '@js-temporal/polyfill';
// dprint-ignore
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    computeAuthInboxMutation,
    validateAuthInboxMutation,
    type AuthInboxMutationRead
} from '@shared-server/rallar-system/auth/inbox/compute-auth-inbox-mutation.ts';
import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { computeAuthMutation } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';
import { validateAuthMutation } from '@shared-server/rallar-system/auth/mutation/validate/validate-auth-mutation.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

const session = {
    clientId: 'client-1',
    username: 'alice',
    sessionId: 'session-1',
    accessTokenDigest: 'access-token-digest',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 2_000
} as const;
const command = {
    version: 1,
    kind: 'logout-session',
    requestId: 'logout-request',
    capturedAtEpochMs: 1_001,
    expected: session
} as const;

describe('auth logout outbox', () => {
    it('preserves the exact logout outbox and omits it for an absent-session no-op', () => {
        const computed = computeAuthMutation({
            command,
            read: {
                kind: 'logout-session',
                byToken: entry(session, 'token-digest=access-token-digest'),
                bySession: entry(session, 'session=session-1'),
                expiredByTokenEntry: null,
                expiredBySessionEntry: null
            },
            facts: { kind: command.kind },
            serviceId: 'auth-service'
        });
        const outbox = computed.logoutOutbox?.entry;
        if (!outbox) {
            throw new Error('Expected logout outbox');
        }

        expect(outbox.key).toEqual({
            topicId: 'auth.session.logout',
            resourceId: 'logout-request',
            contextId: 'session-1'
        });
        expect(outbox.resource).toBe(
            '{"id":{"v":2,"msgId":"auth-logout:logout-request","ts":1001,"senderId":"auth-service"},"route":{"topicId":"auth.session.logout","resourceId":"logout-request","contextId":"session-1"},"targets":{"mode":"unicast","toPeerId":"session-1"},"constraints":{"expiresAtMs":2000},"payload":{"typeId":"auth.session.logout.v1","contentType":"application/json","resource":"{\\"sessionId\\":\\"session-1\\",\\"closeCode\\":1000,\\"reason\\":\\"auth-logout\\"}"},"audit":{"createdBy":"auth-service","createdTs":1001}}'
        );
        expect(outbox.typeId).toBe('WS_OUTBOX');
        expect(outbox.status).toBe('NEW');
        expect(outbox.audit.createdBy).toBe('auth-service');
        expect(outbox.audit.createdTs.toString()).toBe('1970-01-01T00:00:01.001');
        expect(outbox.audit.expiryTs.toString()).toBe('1970-01-01T00:00:02Z');
        expect(outbox.dequeueAudit).toEqual({ attempts: 0 });
        expect(computed.logoutOutbox).toMatchObject({
            systemDate: '1970-01-01',
            createdAt: '1970-01-01T00:00:01.001Z',
            expiresAt: '1970-01-01T00:00:02Z',
            startedAt: null,
            finishedAt: null,
            nextAt: null,
            attempts: 0
        });
        expect(computed).toMatchObject({
            logoutDeletion: {
                sessionStorageKey: 'session=session-1',
                tokenStorageKey: 'token-digest=access-token-digest',
                expectedSessionRevision: 0,
                expectedTokenRevision: 0
            }
        });

        const noOp = computeAuthMutation({
            command,
            read: {
                kind: 'logout-session',
                byToken: null,
                bySession: null,
                expiredByTokenEntry: null,
                expiredBySessionEntry: null
            },
            facts: { kind: command.kind },
            serviceId: 'auth-service'
        });

        expect(noOp.outcome).toBe('no-op');
        expect(noOp.logoutOutbox).toBeNull();
        expect(noOp).toMatchObject({ logoutDeletion: null });
    });

    it.each(
        [
            ['sessionStorageKey', 'session=forged'],
            ['tokenStorageKey', 'token-digest=forged'],
            ['expectedSessionRevision', 1],
            ['expectedTokenRevision', 1]
        ] as const
    )('rejects a changed logout deletion %s before write', (field, value) => {
        const read = createLogoutInboxRead();
        const computed = computeAuthInboxMutation(read);
        const candidate = {
            ...computed,
            mutation: {
                ...computed.mutation,
                logoutDeletion: {
                    sessionStorageKey: 'session=session-1',
                    tokenStorageKey: 'token-digest=access-token-digest',
                    expectedSessionRevision: 0,
                    expectedTokenRevision: 0,
                    [field]: value
                }
            }
        };

        expect(() => Reflect.apply(validateAuthMutation, undefined, [read.command, read.read, candidate.mutation])).toThrow(AuthMutationRejectedError);
        expect(candidate.mutation.logoutDeletion).toMatchObject({ [field]: value });
    });

    it('encodes both logout storage keys during compute', () => {
        const expected = {
            ...session,
            sessionId: 'session:value',
            accessTokenDigest: 'access:token'
        };
        const computed = computeAuthMutation({
            command: { ...command, expected },
            read: {
                kind: 'logout-session',
                byToken: entry(expected, 'token-digest=access%3Atoken'),
                bySession: entry(expected, 'session=session%3Avalue'),
                expiredByTokenEntry: null,
                expiredBySessionEntry: null
            },
            facts: { kind: command.kind },
            serviceId: 'auth-service'
        });

        expect(computed).toMatchObject({
            logoutDeletion: {
                sessionStorageKey: 'session=session%3Avalue',
                tokenStorageKey: 'token-digest=access%3Atoken'
            }
        });
    });

    it.each(['systemDate', 'createdAt', 'expiresAt', 'nextAt'] as const)(
        'rejects a changed persistence field %s before write without replacing it',
        (field) => {
            const read = createLogoutInboxRead();
            const computed = computeAuthInboxMutation(read);
            if (!computed.mutation.logoutOutbox) {
                throw new Error('Expected computed logout outbox');
            }
            expect(validateAuthInboxMutation(read, computed)).toEqual([]);
            const candidate = {
                ...computed,
                mutation: {
                    ...computed.mutation,
                    logoutOutbox: { ...computed.mutation.logoutOutbox, [field]: 'forged' }
                }
            };

            expect(validateAuthInboxMutation(read, candidate).length).toBeGreaterThan(0);
            expect(candidate.mutation.logoutOutbox[field]).toBe('forged');
        }
    );

    it('rejects a persistence accessor without running its callback', () => {
        const read = createLogoutInboxRead();
        const computed = computeAuthInboxMutation(read);
        if (!computed.mutation.logoutOutbox) {
            throw new Error('Expected computed logout outbox');
        }
        let getterCalls = 0;
        const outbox = Object.defineProperty({ ...computed.mutation.logoutOutbox }, 'createdAt', {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return '1970-01-01T00:00:01.001Z';
            }
        });
        const candidate = { ...computed, mutation: { ...computed.mutation, logoutOutbox: outbox } };

        expect(validateAuthInboxMutation(read, candidate).length).toBeGreaterThan(0);
        expect(getterCalls).toBe(0);
    });
});

function createLogoutInboxRead(): AuthInboxMutationRead {
    return {
        command,
        read: {
            kind: 'logout-session',
            byToken: entry(session, 'token-digest=access-token-digest'),
            bySession: entry(session, 'session=session-1'),
            expiredByTokenEntry: null,
            expiredBySessionEntry: null
        },
        facts: { kind: command.kind },
        serviceId: 'auth-service',
        completionFacts: {
            entry: {
                key: { topicId: 'AUTH_SESSION_LOGOUT', resourceId: 'logout-request', contextId: 'client-1' },
                resource: '{}',
                typeId: 'APP_INBOX',
                status: EntityStatus.RESERVED,
                audit: {
                    date: Temporal.PlainTime.from('00:00:01'),
                    createdBy: 'auth-service',
                    createdTs: Temporal.PlainDateTime.from('1970-01-01T00:00:01'),
                    expiryTs: Temporal.Instant.fromEpochMilliseconds(2_000)
                },
                dequeueAudit: { attempts: 1 }
            },
            completedAtEpochMs: 1_010
        }
    };
}

function entry<T>(value: T, key: string) {
    return {
        entry: {
            key,
            value: JSON.stringify(value),
            expireAtTimestamp: 2_000,
            updatedTimestamp: '1970-01-01T00:00:01.000Z',
            revision: 0
        },
        value
    };
}

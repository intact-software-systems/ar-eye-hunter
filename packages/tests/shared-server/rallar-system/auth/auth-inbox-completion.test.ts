import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { computeAuthInboxMutation, validateAuthInboxMutation } from '@shared-server/rallar-system/auth/inbox/compute-auth-inbox-mutation.ts';
import type { AuthMutationCommand, AuthMutationRead } from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

describe('auth inbox completion candidate', () => {
    it('computes the durable session and reservation completion together from explicit facts', () => {
        const read = createRead();
        const computed = computeAuthInboxMutation(read);

        expect(computed.mutation.result).toEqual({
            requestId: 'completion-request',
            kind: 'session-issued',
            clientId: 'client-1',
            username: 'alice',
            sessionId: 'session-1',
            accessTokenDigest: 'a'.repeat(64),
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000
        });
        expect(computed.completion.durableResult).toBe(computed.mutation.result);
        expect(computed.completion.reservationFinish).toEqual({
            key: read.completionFacts.entry.key,
            expectedAttempts: 1,
            status: EntityStatus.COMPLETED,
            completedAt: new Date(1_010)
        });
        expect(validateAuthInboxMutation(read, computed)).toEqual([]);
    });

    it('rejects altered domain writes, encoded results and completion facts without replacing the candidate', () => {
        const read = createRead();
        const computed = computeAuthInboxMutation(read);
        const originalResult = computed.completion.durableResult;
        const changed = { ...computed, mutation: { ...computed.mutation, sessions: [] } };

        expect(Reflect.apply(validateAuthInboxMutation, undefined, [read, changed]).length).toBeGreaterThan(0);
        expect(changed.mutation.sessions).toEqual([]);
        expect(changed.completion.durableResult).toBe(originalResult);
        expect(
            validateAuthInboxMutation({
                ...read,
                completionFacts: { ...read.completionFacts, completedAtEpochMs: 2_000 }
            }, computed).length
        ).toBeGreaterThan(0);
        expect(
            validateAuthInboxMutation(read, {
                ...computed,
                completion: { ...computed.completion, encodedResult: { forged: true } }
            }).length
        ).toBeGreaterThan(0);
    });

    it('returns the canonical authorization rejection without changing the read or computed candidate', () => {
        const original = createRead();
        const read = {
            ...original,
            command: { ...original.command, authority: { ...original.command.authority, normalizedUsername: 'other' } }
        };
        const computed = computeAuthInboxMutation(read);

        const issues = validateAuthInboxMutation(read, computed);

        expect(issues).toHaveLength(1);
        expect(issues[0].cause).toBeInstanceOf(AuthMutationRejectedError);
        expect(issues[0].cause).toMatchObject({ code: 'auth-mutation-rejected', status: 403 });
        expect(read.command.authority.normalizedUsername).toBe('other');
        expect(computed.mutation.command).toBe(read.command);
        expect(computed.mutation.result).toMatchObject({ username: 'alice' });
    });

    it('rejects hidden extra session writes without invoking a candidate serialization callback', () => {
        const read = createRead();
        const computed = computeAuthInboxMutation(read);
        let callbackCalls = 0;
        const candidate = {
            ...computed,
            mutation: {
                ...computed.mutation,
                sessions: [...computed.mutation.sessions, ...computed.mutation.sessions],
                toJSON: () => {
                    callbackCalls += 1;
                    return computed.mutation;
                }
            }
        };

        const issues = Reflect.apply(validateAuthInboxMutation, undefined, [read, candidate]);

        expect.soft(callbackCalls).toBe(0);
        expect.soft(issues.length).toBeGreaterThan(0);
        expect(candidate.mutation.sessions).toHaveLength(2);
    });

    it('rejects an accessor before reading the mutation it exposes', () => {
        const read = createRead();
        const computed = computeAuthInboxMutation(read);
        let getterCalls = 0;
        const candidate = Object.defineProperty({ ...computed }, 'mutation', {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return computed.mutation;
            }
        });

        expect(validateAuthInboxMutation(read, candidate).length).toBeGreaterThan(0);
        expect(getterCalls).toBe(0);
    });

    it.each(['candidate', 'mutation', 'completion'] as const)('rejects a %s Proxy without invoking its traps', (placement) => {
        const read = createRead();
        const computed = computeAuthInboxMutation(read);
        let trapCalls = 0;
        const inspect = (): never => {
            trapCalls += 1;
            throw new Error('Candidate inspection must not invoke Proxy traps');
        };
        const traps = { get: inspect, getPrototypeOf: inspect, ownKeys: inspect, getOwnPropertyDescriptor: inspect };
        const candidate = placement === 'candidate'
            ? new Proxy(computed, traps)
            : { ...computed, [placement]: new Proxy(computed[placement], traps) };

        expect(validateAuthInboxMutation(read, candidate).length).toBeGreaterThan(0);
        expect(trapCalls).toBe(0);
    });
});

function createRead() {
    const command: AuthMutationCommand = {
        version: 1,
        kind: 'issue-session',
        requestId: 'completion-request',
        capturedAtEpochMs: 1_000,
        authority: { kind: 'static-client', clientId: 'client-1', normalizedUsername: 'alice' },
        session: {
            clientId: 'client-1',
            username: 'alice',
            sessionId: 'session-1',
            accessTokenDigest: 'a'.repeat(64),
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000
        }
    };
    const read: AuthMutationRead = {
        kind: 'issue-session',
        userByUsername: null,
        userByClientId: null,
        byToken: null,
        bySession: null,
        expiredByTokenEntry: null,
        expiredBySessionEntry: null
    };
    return {
        command,
        read,
        facts: { kind: command.kind },
        serviceId: 'auth-test-service',
        completionFacts: { entry: createEntry(), completedAtEpochMs: 1_010 }
    };
}

function createEntry(): ResourceEntry {
    return {
        key: { topicId: 'AUTH_ISSUE_SESSION', resourceId: 'completion-request', contextId: 'client-1' },
        resource: '{}',
        typeId: 'APP_INBOX',
        status: EntityStatus.RESERVED,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'auth-test-service',
            createdTs: Temporal.PlainDateTime.from('2026-08-07T12:00:00'),
            expiryTs: Temporal.Instant.from('2026-08-07T13:00:00Z')
        },
        dequeueAudit: { attempts: 1 }
    };
}

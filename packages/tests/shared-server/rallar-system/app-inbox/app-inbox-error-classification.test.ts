import { AppInboxIdempotencyConflictError, AppInboxReservationConflictError } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { classifyAppInboxError } from '@shared-server/rallar-system/app-inbox/app-inbox-error-classification.ts';
import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { GroupMutationRejectedError } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import { GroupTopologyConfigValidationError } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { describe, expect, it } from 'vitest';

describe('AppInbox error classification', () => {
    it('serializes typed validation issues into the current failure contract', () => {
        const classification = classifyAppInboxError(
            new GroupTopologyConfigValidationError([
                {
                    code: 'invalid-positive-integer',
                    path: ['degreeLimit'],
                    message: 'degreeLimit must be a positive integer',
                    details: { value: 0 }
                }
            ])
        );

        expect(classification).toEqual({
            kind: 'terminal',
            code: 'group-topology-config-validation-failed',
            result: {
                type: 'app-inbox-failure',
                code: 'group-topology-config-validation-failed',
                status: 422,
                message: 'Group topology config validation failed',
                issues: [
                    {
                        code: 'invalid-positive-integer',
                        path: ['degreeLimit'],
                        message: 'degreeLimit must be a positive integer',
                        details: { value: 0 }
                    }
                ],
                denial: null,
                retry: null
            }
        });
    });

    it('uses typed status and denial data instead of reflecting arbitrary errors', () => {
        const classification = classifyAppInboxError(
            new AuthMutationRejectedError('Session credentials are invalid', 401)
        );

        expect(classification).toMatchObject({
            kind: 'terminal',
            code: 'auth-mutation-rejected',
            result: {
                code: 'auth-mutation-rejected',
                status: 401,
                denial: {
                    code: 'auth-mutation-rejected',
                    message: 'Session credentials are invalid',
                    details: null
                }
            }
        });
    });

    it('fails closed when typed policy details are not JSON-safe', () => {
        const classification = classifyAppInboxError(
            new GroupPolicyDeniedError({
                allowed: false,
                code: 'group-policy-denied',
                message: 'The mutation is forbidden',
                details: { amount: 1n }
            })
        );

        expect(classification).toMatchObject({
            kind: 'terminal',
            code: 'app-inbox-failure-metadata-invalid',
            result: {
                code: 'app-inbox-failure-metadata-invalid',
                status: 500
            }
        });
    });

    it.each([
        {
            name: 'reservation conflict',
            error: new AppInboxReservationConflictError({
                topicId: 'app-inbox.group-state',
                resourceId: 'request-1',
                contextId: 'group-1'
            }),
            kind: 'retryable'
        },
        {
            name: 'idempotency conflict',
            error: new AppInboxIdempotencyConflictError('request-1', 'existing', 'received'),
            kind: 'terminal'
        },
        {
            name: 'domain rejection',
            error: new GroupMutationRejectedError('The mutation is invalid'),
            kind: 'terminal'
        },
        {
            name: 'boundary type failure',
            error: new TypeError('The command is malformed'),
            kind: 'terminal'
        },
        {
            name: 'unclassified runtime failure',
            error: new Error('The database connection was interrupted'),
            kind: 'retryable'
        }
    ])('classifies $name by its current typed contract', ({ error, kind }) => {
        expect(classifyAppInboxError(error).kind).toBe(kind);
    });
});

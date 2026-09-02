import { describe, expect, it } from 'vitest';

import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import {
    computeTopologyConfigAppInboxMutation,
    validateTopologyConfigAppInboxMutation,
    type TopologyConfigAppInboxRead
} from '@shared-server/rallar-system/topology/inbox/compute-topology-config-app-inbox-mutation.ts';
import {
    computeTopologyReconfigureAppInboxMutation,
    validateTopologyReconfigureAppInboxMutation,
    type TopologyReconfigureAppInboxRead
} from '@shared-server/rallar-system/topology/inbox/compute-topology-reconfigure-app-inbox-mutation.ts';
import { EntityStatus, toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createTopologyConfigMutationTestInput } from '../config/mutation/group-topology-config-mutation-test-fixtures.ts';

describe('topology AppInbox completion computation', () => {
    it('rejects a config domain proxy without invoking its traps', () => {
        const read = configRead();
        const computed = computeTopologyConfigAppInboxMutation(read);
        let reads = 0;
        const candidate = new Proxy(computed, {
            get(target, key, receiver) {
                reads += 1;
                return Reflect.get(target, key, receiver);
            },
            getOwnPropertyDescriptor(target, key) {
                reads += 1;
                return Reflect.getOwnPropertyDescriptor(target, key);
            }
        });

        expect(validateTopologyConfigAppInboxMutation(read, candidate).length).toBeGreaterThan(0);
        expect(reads).toBe(0);
    });

    it('rejects a config toJSON projection that hides altered runtime writes without invoking it', () => {
        const read = configRead();
        const computed = computeTopologyConfigAppInboxMutation(read);
        if (computed.completion === null || computed.mutation.outcome !== 'write') {
            throw new Error('Expected a config write');
        }
        let calls = 0;
        const candidate = {
            ...computed,
            mutation: {
                ...computed.mutation,
                runtimeWrites: [],
                toJSON: () => {
                    calls += 1;
                    return computed.mutation;
                }
            }
        };

        expect(validateTopologyConfigAppInboxMutation(read, candidate).length).toBeGreaterThan(0);
        expect(calls).toBe(0);
    });

    it('rejects a reconfigure proxy without invoking its traps', () => {
        const read = reconfigureRead();
        const computed = computeTopologyReconfigureAppInboxMutation(read);
        let reads = 0;
        const candidate = new Proxy(computed, {
            get(target, key, receiver) {
                reads += 1;
                return Reflect.get(target, key, receiver);
            },
            getOwnPropertyDescriptor(target, key) {
                reads += 1;
                return Reflect.getOwnPropertyDescriptor(target, key);
            }
        });

        expect(validateTopologyReconfigureAppInboxMutation(read, candidate).length).toBeGreaterThan(0);
        expect(reads).toBe(0);
    });

    it('rejects a reconfigure toJSON projection that hides an altered outbox without invoking it', () => {
        const read = reconfigureRead();
        const computed = computeTopologyReconfigureAppInboxMutation(read);
        let calls = 0;
        const candidate = {
            ...computed,
            mutation: {
                ...computed.mutation,
                outboxWrite: {
                    ...computed.mutation.outboxWrite,
                    entry: { ...computed.mutation.outboxWrite.entry, resource: 'forged' }
                },
                toJSON: () => {
                    calls += 1;
                    return computed.mutation;
                }
            }
        };

        expect(validateTopologyReconfigureAppInboxMutation(read, candidate).length).toBeGreaterThan(0);
        expect(calls).toBe(0);
    });

    it('preserves explicit server defaults and rejects changed config or completion without replacement', () => {
        const read = configRead();
        const computed = computeTopologyConfigAppInboxMutation(read);
        if (computed.completion === null || computed.mutation.outcome !== 'write') {
            throw new Error('Expected a completed config write');
        }
        expect(computed.completion.durableResult).toMatchObject({
            config: { config: { degreeLimit: 8 } },
            receipt: { attemptCount: 3 }
        });
        expect(validateTopologyConfigAppInboxMutation(read, computed)).toEqual([]);
        expect(computeTopologyConfigAppInboxMutation(read)).toEqual(computed);
        const candidate = {
            ...computed,
            mutation: { ...computed.mutation, runtimeWrites: [] },
            completion: {
                ...computed.completion,
                reservationFinish: { ...computed.completion.reservationFinish, expectedAttempts: 9 }
            }
        };
        expect(validateTopologyConfigAppInboxMutation(read, candidate).map((issue) => issue.path))
            .toEqual(expect.arrayContaining(['computed.mutation.runtimeWrites.length', 'computed.completion.reservationFinish.expectedAttempts']));
        expect(candidate.mutation.runtimeWrites).toEqual([]);
        expect(candidate.completion.reservationFinish.expectedAttempts).toBe(9);
    });

    it('completes a receipt replay but leaves conflicting idempotency for the existing failure owner', () => {
        const read = configRead();
        const first = computeTopologyConfigAppInboxMutation(read);
        if (first.mutation.outcome !== 'write' || first.mutation.idempotency === null) {
            throw new Error('Expected an idempotent config write');
        }
        const record = first.mutation.idempotency;
        const replayRead = {
            ...read,
            mutationRead: {
                ...read.mutationRead,
                state: {
                    ...read.mutationRead.state,
                    idempotency: {
                        key: record.requestId,
                        value: record,
                        entry: {
                            key: record.requestId,
                            value: JSON.stringify(record),
                            revision: 0,
                            expireAtTimestamp: 60_000,
                            updatedTimestamp: '1970-01-01T00:00:01.000Z'
                        }
                    }
                }
            }
        };
        const replay = computeTopologyConfigAppInboxMutation(replayRead);
        expect(replay.mutation.outcome).toBe('replay');
        expect(replay.completion?.durableResult).toEqual(first.completion?.durableResult);
        expect(validateTopologyConfigAppInboxMutation(replayRead, replay)).toEqual([]);
        const conflictRead = { ...replayRead, attempt: { ...read.attempt, commandHash: `sha256:${'b'.repeat(64)}` } };
        const conflict = computeTopologyConfigAppInboxMutation(conflictRead);
        expect(conflict.mutation.outcome).toBe('idempotency-conflict');
        expect(conflict.completion).toBeNull();
        expect(validateTopologyConfigAppInboxMutation(conflictRead, conflict)).toEqual([]);
    });

    it('validates all reconfigure persistence fields and the exact completion against the original read', () => {
        const read = reconfigureRead();
        const computed = computeTopologyReconfigureAppInboxMutation(read);
        expect(computed.mutation.authorityWriteExpectedResultRevision).toBe(1);
        expect(computed.completion.durableResult).toEqual({
            status: 'queued',
            groupRef: read.command.groupRef,
            requestId: 'reconfigure-request',
            outboxId: 'reconfigure-request:rtc-topology-recompute:explicit'
        });
        expect(validateTopologyReconfigureAppInboxMutation(read, computed)).toEqual([]);
        expect(computeTopologyReconfigureAppInboxMutation(read)).toEqual(computed);
        const candidate = {
            ...computed,
            mutation: { ...computed.mutation, resourceId: 'forged-outbox' },
            completion: {
                ...computed.completion,
                reservationFinish: { ...computed.completion.reservationFinish, completedAt: new Date(9_000) }
            }
        };
        expect(validateTopologyReconfigureAppInboxMutation(read, candidate).map((issue) => issue.path))
            .toEqual(expect.arrayContaining(['computed.mutation.resourceId', 'computed.completion.reservationFinish.completedAt']));
        expect(validateTopologyReconfigureAppInboxMutation({
            ...read,
            command: { ...read.command, publish: false }
        }, computed)).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'computed.mutation.publish' })]));
    });
});

function configRead(): TopologyConfigAppInboxRead {
    const input = createTopologyConfigMutationTestInput();
    const entry = toResourceEntry('APP_INBOX', { requestId: input.command.requestId });
    return {
        command: input.command,
        mutationRead: {
            state: input.read,
            policyNowEpochMs: 1_000,
            actorIsPlatformAdmin: false,
            serverDefaults: { degreeLimit: 8 }
        },
        attempt: { commandHash: input.facts.commandHash, capturedAtEpochMs: 1_000, count: 3 },
        completionFacts: {
            entry: { ...entry, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 3 } },
            completedAtEpochMs: 1_500
        }
    };
}

function reconfigureRead(): TopologyReconfigureAppInboxRead {
    const config = configRead();
    return {
        command: {
            groupRef: config.command.aggregateRef,
            commandId: 'reconfigure-request',
            actorPrincipalId: 'owner',
            capturedAtEpochMs: 1_000,
            requestOptions: {},
            publish: true
        },
        mutationRead: {
            authority: {
                group: config.mutationRead.state.groupSnapshot,
                config: resolveGroupTopologyConfig({}),
                kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
                rttMeasurements: [],
                replanning: 'auto',
                nowEpochMs: 1_000
            },
            authorityGuard: config.mutationRead.state.groupAuthorityGuard,
            actorIsPlatformAdmin: false
        },
        completionFacts: config.completionFacts
    };
}

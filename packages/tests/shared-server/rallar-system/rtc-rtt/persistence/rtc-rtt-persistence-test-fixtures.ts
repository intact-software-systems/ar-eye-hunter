import type { RtcRttAppInboxDependencies } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-app-inbox-contracts.ts';
import { RtcRttInboxService } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-inbox-service.ts';
import { computeRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/compute-rtc-rtt-mutation.ts';
import type { RtcRttMutationComputed } from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-contracts.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import type { AuthorityHarness } from '../../group-state/inbox/group-state-inbox-test-runtime.ts';
import { createRtcTopologyGroupSnapshot } from '../../topology/rtc-topology-test-fixtures.ts';

interface CreateRtcRttInboxTestRuntimeInput {
    readonly harness: AuthorityHarness;
    readonly nowEpochMs: () => number;
    readonly ttlMs: number;
    readonly readPolicyInputs: RtcRttAppInboxDependencies['readPolicyInputs'];
}

export interface RtcRttInboxTestRuntime {
    readonly repository: RtcRttRepository;
    readonly dependencies: RtcRttAppInboxDependencies;
    readonly reader: InboxQueueReader;
    readonly service: RtcRttInboxService;
    readonly observations: readonly RttMeasurementInfo[];
    readonly recordedWrites: readonly number[];
}

export function createRtcRttInboxTestRuntime(input: CreateRtcRttInboxTestRuntimeInput): RtcRttInboxTestRuntime {
    const repository = new RtcRttRepository(input.harness.runtimeRepository, {
        now: input.nowEpochMs,
        ttlMs: input.ttlMs
    });
    const observations: RttMeasurementInfo[] = [];
    const recordedWrites: number[] = [];
    const dependencies: RtcRttAppInboxDependencies = {
        repository,
        outboxWriter: new RtcTopologyOutboxWriter({
            recordWrite: () => {
                recordedWrites.push(1);
            }
        }),
        readPolicyInputs: input.readPolicyInputs,
        observeCommitted: (rtt) => observations.push(rtt)
    };
    const reader = new InboxQueueReader(input.harness.queue);
    const service = new RtcRttInboxService({
        inboxQueueReader: reader,
        resourceInboxRepository: input.harness.queue,
        resourceInboxResultsRepository: input.harness.results,
        database: input.harness.database,
        groupStateService: input.harness.groupStateService,
        mutationDependencies: dependencies
    }, {
        serviceId: 'rtt-convergence-test',
        options: { nowEpochMs: input.nowEpochMs }
    });
    return { repository, dependencies, reader, service, observations, recordedWrites };
}

export function createRttGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    atEpochMs: number
): GroupSnapshot {
    const snapshot = createRtcTopologyGroupSnapshot(groupId, sessionIds);
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => ({
            ...session,
            generationVersion: atEpochMs,
            connectedAtEpochMs: atEpochMs,
            lastHeartbeatAtEpochMs: atEpochMs,
            expiresAtEpochMs: atEpochMs + 60_000
        }))
    };
}

type DeepMutable<Value> = Value extends readonly (infer Entry)[] ? DeepMutable<Entry>[] :
    Value extends object ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]>; } :
    Value;

export type MutableRttWriteCandidate =
    & DeepMutable<Omit<Extract<RtcRttMutationComputed, { outcome: 'write'; }>, 'outboxWrites'>>
    & Pick<Extract<RtcRttMutationComputed, { outcome: 'write'; }>, 'outboxWrites'>;

export function createValidRttWriteCandidate(): Extract<RtcRttMutationComputed, { outcome: 'write'; }> {
    const computed = computeRtcRttMutation({
        command: {
            rtt: {
                sessionIdFrom: 'session-a',
                sessionIdTo: 'session-b',
                rttMs: 1,
                createdAtEpochMs: 1,
                version: 1
            },
            alSenderId: 'session-a',
            candidateGroups: [createRttGroupSnapshot('room-write-gate', ['session-a', 'session-b'], 1)],
            overlaySnapshotsByGroupKey: new Map(),
            degreeLimit: 1
        },
        read: {
            receipt: null,
            measurement: null,
            expiredMeasurementEntry: null,
            endpointAdmissions: [],
            expiredEndpointAdmissionEntries: [],
            measurements: []
        },
        facts: {
            commandHash: `sha256:${'a'.repeat(64)}`,
            attemptCount: 1,
            requestedAtEpochMs: 2,
            purgeAfterEpochMs: 60_002
        }
    });
    if (computed.outcome !== 'write') {
        throw new Error('Expected RTT write');
    }
    return computed;
}

export function createMutableRttWriteCandidate(): MutableRttWriteCandidate {
    const { outboxWrites, ...candidate } = createValidRttWriteCandidate();
    return { ...structuredClone(candidate), outboxWrites } as MutableRttWriteCandidate;
}

interface RttWriteCandidateCorruption {
    readonly label: string;
    corrupt(candidate: MutableRttWriteCandidate): object;
}

export const rttWriteCandidateCorruptions: readonly RttWriteCandidateCorruption[] = [
    {
        label: 'a missing endpoint guard field',
        corrupt: (candidate) => {
            const { endpointGuards: _removedEndpointGuards, ...withoutEndpointGuards } = candidate;
            return withoutEndpointGuards;
        }
    },
    {
        label: 'an extra write-candidate field',
        corrupt: (candidate) => ({ ...candidate, unexpected: true })
    },
    {
        label: 'only one endpoint guard',
        corrupt: (candidate) => ({
            ...candidate,
            endpointGuards: candidate.endpointGuards.slice(0, 1)
        })
    },
    {
        label: 'an extra endpoint guard',
        corrupt: (candidate) => ({
            ...candidate,
            endpointGuards: [...candidate.endpointGuards, structuredClone(candidate.endpointGuards[1]!)]
        })
    },
    {
        label: 'endpoint guards outside lexical order',
        corrupt: (candidate) => ({
            ...candidate,
            endpointGuards: [...candidate.endpointGuards].reverse()
        })
    },
    {
        label: 'duplicate endpoint guard identities',
        corrupt: (candidate) => {
            candidate.endpointGuards[1]!.endpointId = 'session-a';
            candidate.endpointGuards[1]!.value.endpointId = 'session-a';
            return candidate;
        }
    },
    {
        label: 'an extra endpoint guard field',
        corrupt: (candidate) => ({
            ...candidate,
            endpointGuards: candidate.endpointGuards.map((guard, index) => index === 0 ? { ...guard, unexpected: true } : guard)
        })
    },
    {
        label: 'an invalid endpoint expected revision',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.expectedRevision = -1;
            return candidate;
        }
    },
    ...([0, 1] as const).map((endpointIndex) => ({
        label: `endpoint ${endpointIndex + 1} insert domain version differing from its storage guard`,
        corrupt: (candidate: MutableRttWriteCandidate) => {
            candidate.endpointGuards[endpointIndex]!.value.version = 2;
            return candidate;
        }
    })),
    ...([0, 1] as const).map((endpointIndex) => ({
        label: `endpoint ${endpointIndex + 1} update domain version differing from its storage guard`,
        corrupt: (candidate: MutableRttWriteCandidate) => {
            candidate.endpointGuards[endpointIndex]!.expectedRevision = 0;
            candidate.endpointGuards[endpointIndex]!.value.version = 1;
            return candidate;
        }
    })),
    {
        label: 'an endpoint update whose next domain version would overflow',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.expectedRevision = Number.MAX_SAFE_INTEGER - 1;
            candidate.endpointGuards[0]!.value.version = Number.MAX_SAFE_INTEGER;
            return candidate;
        }
    },
    {
        label: 'an endpoint value bound to another identity',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.value.endpointId = 'session-c';
            return candidate;
        }
    },
    {
        label: 'an endpoint value missing the receipt peer',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.value.peers = [
                {
                    peerSessionId: 'session-c',
                    expiresAtEpochMs: 60_002
                }
            ];
            return candidate;
        }
    },
    {
        label: 'an endpoint lease before the measurement purge time',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.value.peers[0]!.expiresAtEpochMs = 60_001;
            candidate.endpointGuards[0]!.expireAtTimestamp = 60_001;
            return candidate;
        }
    },
    {
        label: 'an endpoint physical expiry differing from its leases',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.expireAtTimestamp += 1;
            return candidate;
        }
    },
    {
        label: 'a missing measurement guard field',
        corrupt: (candidate) => {
            const {
                expectedRevision: _removedExpectedRevision,
                ...measurementGuardWithoutExpectedRevision
            } = candidate.measurementGuard;
            return { ...candidate, measurementGuard: measurementGuardWithoutExpectedRevision };
        }
    },
    {
        label: 'an extra measurement guard field',
        corrupt: (candidate) => ({
            ...candidate,
            measurementGuard: { ...candidate.measurementGuard, unexpected: true }
        })
    },
    {
        label: 'an invalid measurement expected revision',
        corrupt: (candidate) => {
            candidate.measurementGuard.expectedRevision = -1;
            return candidate;
        }
    },
    {
        label: 'a measurement value differing from receipt',
        corrupt: (candidate) => {
            candidate.measurementGuard.value = {
                ...candidate.measurementGuard.value,
                sessionIdTo: 'session-c'
            };
            return candidate;
        }
    },
    {
        label: 'an outbox identity differing from the affected group',
        corrupt: (candidate) => {
            candidate.receipt.outboxIds[0] = 'wrong-outbox-id';
            return candidate;
        }
    },
    {
        label: 'a missing sender identity',
        corrupt: (candidate) => {
            candidate.senderId = '';
            return candidate;
        }
    },
    {
        label: 'a purge time outside the accepted lifecycle',
        corrupt: (candidate) => {
            candidate.measurementGuard.purgeAfterEpochMs = 2;
            return candidate;
        }
    },
    {
        label: 'affected groups differing from receipt',
        corrupt: (candidate) => ({ ...candidate, affectedGroups: [] })
    }
];

import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type {
    GroupStateRepository
} from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import {
    initRtcTopologyScalarRecomputeWorker
} from '@shared-server/rallar-system/repositories/RtcTopologyScalarAuthorityMigration.ts';
import {
    deriveRtcTopologyEntryResourceId,
    writeRtcTopologyOutbox
} from '@shared-server/rallar-system/services/rtc-topology-outbox-entry.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

type ScalarRecomputeWorkerInput = Parameters<typeof initRtcTopologyScalarRecomputeWorker>[0];

export interface InitApiRtcTopologyScalarRecomputeWorkerInput {
    readonly runtimeStateRepository: ScalarRecomputeWorkerInput['runtime'];
    readonly groupsRepository: Pick<GroupStateRepository, 'readSnapshot'>;
    readonly database: PSqlSql;
    readonly serviceId: string;
    readonly now: () => number;
    readonly wake: () => void;
}

export function initApiRtcTopologyScalarRecomputeWorker(
    input: InitApiRtcTopologyScalarRecomputeWorkerInput
): ReturnType<typeof initRtcTopologyScalarRecomputeWorker> {
    return initRtcTopologyScalarRecomputeWorker({
        runtime: input.runtimeStateRepository,
        process: async (groupRef, requestId) => {
            const groupSnapshot = await input.groupsRepository.readSnapshot(groupRef);
            if (!groupSnapshot) {
                return 'group-absent-terminal';
            }
            const createdAtEpochMs = input.now();
            const identity = {
                commandId: requestId,
                effectKind: 'rtc-topology-recompute' as const,
                payloadKind: 'group-revision' as const,
                acceptedCausalRevision: groupSnapshot.causalRevision
            };
            await input.database.begin(async (transaction) => {
                await writeRtcTopologyOutbox(transaction, {
                    ...identity,
                    resourceId: deriveRtcTopologyEntryResourceId(identity),
                    aggregateRef: groupRef,
                    groupSnapshot,
                    createdAtEpochMs,
                    expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP,
                    senderId: input.serviceId,
                    requestOptions: toCanonicalGroupTopologyConfigPatch({}),
                    publish: true
                });
            });
            input.wake();
            return 'enqueued';
        },
        onError: (error) => {
            console.error('Failed to drain RTC topology scalar recompute requests:', error);
        }
    });
}

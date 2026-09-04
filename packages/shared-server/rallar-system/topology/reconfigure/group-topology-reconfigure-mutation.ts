import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import { readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { decodeRuntimeStateRevision } from '../../../runtime-state/postgres/runtime-state-row-codec.ts';
import type { GroupStateRepository } from '../../group-state/persistence/group-state-repository.ts';
import { GROUPS_NAMESPACE } from '../../group-state/persistence/group-state-runtime-namespaces.ts';
import { canUpdateGroupSnapshot } from '../../group-state/policy/group-governance-policy.ts';
import { canMutateActiveGroup } from '../../group-state/policy/group-lifecycle-policy.ts';
import { GroupPolicyDeniedError } from '../../group-state/policy/group-policy-result.ts';
import {
    computeRtcTopologyOutboxInsert,
    type ComputedRtcTopologyOutbox
} from '../mutation/rtc-topology-outbox-entry.ts';
import type { RtcTopologyOutboxWriter } from '../mutation/rtc-topology-outbox-writer.ts';
import { rtcTopologySemanticEqual } from '../persistence/rtc-topology-semantic-equal.ts';
import type {
    GroupTopologyPlanningAuthority,
    ReadGroupTopologyPlanningAuthorityInput
} from '../planning/group-topology-planning-authority.ts';
import type {
    GroupTopologyReconfigureCommand,
    GroupTopologyReconfigureComputed,
    GroupTopologyReconfigureRead
} from './group-topology-reconfigure-contracts.ts';

export interface GroupTopologyReconfigureMutationDependencies {
    readonly groupStateRepository: GroupStateRepository;
    readonly readPlanningAuthority: (
        input: ReadGroupTopologyPlanningAuthorityInput
    ) => Promise<GroupTopologyPlanningAuthority>;
    readonly isPlatformAdmin: (principalId: string) => boolean;
    readonly outboxWriter: RtcTopologyOutboxWriter;
}

export class GroupTopologyReconfigureMutation {
    private readonly dependencies: GroupTopologyReconfigureMutationDependencies;

    constructor(dependencies: GroupTopologyReconfigureMutationDependencies) {
        this.dependencies = dependencies;
    }

    async read(command: GroupTopologyReconfigureCommand): Promise<GroupTopologyReconfigureRead> {
        const guarded = await this.dependencies.groupStateRepository.readSnapshotWithAuthorityGuard(
            command.groupRef
        );
        if (!guarded) {
            throw new Error(`Group snapshot not found: ${command.groupRef.groupId}`);
        }
        const authority = await this.dependencies.readPlanningAuthority({
            groupRef: command.groupRef,
            requestOptions: command.requestOptions,
            knownGroup: guarded.snapshot
        });
        if (
            compareGroupCausalRevision(
                readGroupCausalRevision(authority.group),
                readGroupCausalRevision(guarded.snapshot)
            ) !== 'equal'
        ) {
            throw new RuntimeStateWriteConflictError();
        }
        return {
            authority,
            authorityGuard: guarded.authorityGuard,
            actorIsPlatformAdmin: this.dependencies.isPlatformAdmin(command.actorPrincipalId)
        };
    }

    compute(
        command: GroupTopologyReconfigureCommand,
        read: GroupTopologyReconfigureRead
    ): GroupTopologyReconfigureComputed {
        const snapshot = read.authority.group;
        const outbox: ComputedRtcTopologyOutbox = {
            commandId: command.commandId,
            resourceId: `${command.commandId}:rtc-topology-recompute:explicit`,
            aggregateRef: command.groupRef,
            acceptedCausalRevision: snapshot.causalRevision,
            groupSnapshot: snapshot,
            effectKind: 'rtc-topology-recompute',
            payloadKind: 'group-revision',
            createdAtEpochMs: command.capturedAtEpochMs,
            expireAtEpochMs: 253_402_300_799_999,
            senderId: command.actorPrincipalId,
            requestOptions: toCanonicalGroupTopologyConfigPatch(command.requestOptions),
            publish: command.publish
        };
        return {
            ...outbox,
            authorityGuard: read.authorityGuard,
            authorityWrite: {
                namespace: GROUPS_NAMESPACE,
                key: read.authorityGuard.entry.key,
                value: read.authorityGuard.entry.value,
                expireAtIsoTimestamp: new Date(
                    read.authorityGuard.entry.expireAtTimestamp
                ).toISOString(),
                expectedRevision: read.authorityGuard.entry.revision,
                expectedResultRevision: read.authorityGuard.entry.revision + 1
            },
            outboxWrite: computeRtcTopologyOutboxInsert(outbox)
        };
    }

    validate(
        command: GroupTopologyReconfigureCommand,
        read: GroupTopologyReconfigureRead,
        computed: GroupTopologyReconfigureComputed
    ): void {
        const lifecycle = canMutateActiveGroup({
            group: read.authority.group.group,
            nowEpochMs: read.authority.nowEpochMs
        });
        if (!lifecycle.allowed) {
            throw new GroupPolicyDeniedError(lifecycle);
        }
        this.validateActor(command, read);
        if (!rtcTopologySemanticEqual(computed, this.compute(command, read))) {
            throw new TypeError('Topology reconfigure computation is invalid');
        }
    }

    async write(
        transaction: PSqlSql,
        computed: GroupTopologyReconfigureComputed
    ): Promise<void> {
        const write = computed.authorityWrite;
        const rows = await transaction<readonly { revision: number | string; }[]>`
            update runtime_state_store
            set store_value = ${write.value},
                expire_at_ts = ${write.expireAtIsoTimestamp},
                updated_ts = now(),
                revision = revision + 1
            where store_namespace = ${write.namespace}
              and store_key = ${write.key}
              and revision = ${write.expectedRevision}
            returning revision
        `;
        if (
            !rows[0] ||
            decodeRuntimeStateRevision(rows[0].revision) !== write.expectedResultRevision
        ) {
            throw new RuntimeStateWriteConflictError();
        }
        await this.dependencies.outboxWriter.write(transaction, computed.outboxWrite);
    }

    recordCommittedWrite(): void {
        this.dependencies.outboxWriter.recordCommittedWrites(1);
    }

    private validateActor(
        command: GroupTopologyReconfigureCommand,
        read: GroupTopologyReconfigureRead
    ): void {
        if (read.actorIsPlatformAdmin) {
            return;
        }
        const policy = canUpdateGroupSnapshot({
            snapshot: read.authority.group,
            actor: { principalId: command.actorPrincipalId },
            nowEpochMs: read.authority.nowEpochMs
        });
        if (!policy.allowed) {
            throw new GroupPolicyDeniedError(policy);
        }
    }
}

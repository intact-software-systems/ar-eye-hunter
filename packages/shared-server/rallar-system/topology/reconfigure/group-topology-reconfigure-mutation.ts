import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import { readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import {
    createTransactionBoundPSqlRuntimeStateRepository
} from '../../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { isValidRuntimeStateUpsertExpectedRevision } from '../../../runtime-state/runtime-state-repository.ts';
import { validateAppInboxComputedProjection } from '../../app-inbox/handler/app-inbox-computed-validation.ts';
import {
    computeAppOutboxInsert,
    writeAppOutboxInsert
} from '../../app-outbox/app-outbox-insert.ts';
import { materializeGroupStateAuthorityGuard } from '../../group-state/persistence/aggregate/group-aggregate-repository.ts';
import type { GroupStateRepository } from '../../group-state/persistence/group-state-repository.ts';
import { GROUPS_NAMESPACE } from '../../group-state/persistence/group-state-runtime-namespaces.ts';
import { canUpdateGroupSnapshot } from '../../group-state/policy/group-governance-policy.ts';
import { canMutateActiveGroup } from '../../group-state/policy/group-lifecycle-policy.ts';
import { GroupPolicyDeniedError } from '../../group-state/policy/group-policy-result.ts';
import { computeRtcTopologyEntry, type ComputedRtcTopologyOutbox } from '../mutation/rtc-topology-outbox-entry.ts';
import type { RtcTopologyOutboxWriter } from '../mutation/rtc-topology-outbox-writer.ts';
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

export interface GroupTopologyReconfigureValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: Error;
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
            knownGroup: guarded.snapshot,
            snapshotSelection: 'prefer-current'
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

    recordCommitted(): void {
        this.dependencies.outboxWriter.recordCommitted();
    }
}

export async function writeGroupTopologyReconfigureMutation(
    transaction: PSqlSql,
    computed: GroupTopologyReconfigureComputed
): Promise<void> {
    const runtime = createTransactionBoundPSqlRuntimeStateRepository(transaction);
    const authorityWrite = computed.authorityWrite;
    const authority = await runtime.upsertIfRevision(
        authorityWrite.namespace,
        authorityWrite.key,
        authorityWrite.value,
        computed.authorityWriteExpireAtIsoTimestamp,
        authorityWrite.expectedRevision
    );
    if (
        authority.status === 'conflict' ||
        authority.revision !== computed.authorityWriteExpectedResultRevision
    ) {
        throw new RuntimeStateWriteConflictError();
    }
    await writeAppOutboxInsert(transaction, computed.outboxWrite);
}

export function computeGroupTopologyReconfigureMutation(
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
            operation: 'update',
            namespace: GROUPS_NAMESPACE,
            key: read.authorityGuard.entry.key,
            expectedRevision: read.authorityGuard.entry.revision,
            value: read.authorityGuard.entry.value,
            expireAtTimestamp: read.authorityGuard.entry.expireAtTimestamp
        },
        authorityWriteExpectedResultRevision: read.authorityGuard.entry.revision + 1,
        authorityWriteExpireAtIsoTimestamp: new Date(
            read.authorityGuard.entry.expireAtTimestamp
        ).toISOString(),
        outboxWrite: computeAppOutboxInsert(computeRtcTopologyEntry(outbox))
    };
}

export function validateGroupTopologyReconfigureMutation(
    command: GroupTopologyReconfigureCommand,
    read: GroupTopologyReconfigureRead,
    computed: GroupTopologyReconfigureComputed
): readonly GroupTopologyReconfigureValidationIssue[] {
    const issues: GroupTopologyReconfigureValidationIssue[] = [];
    const lifecycle = canMutateActiveGroup({
        group: read.authority.group.group,
        nowEpochMs: read.authority.nowEpochMs
    });
    if (!lifecycle.allowed) {
        const cause = new GroupPolicyDeniedError(lifecycle);
        issues.push({ path: 'lifecycle', message: cause.message, cause });
    }
    if (!read.actorIsPlatformAdmin) {
        const policy = canUpdateGroupSnapshot({
            snapshot: read.authority.group,
            actor: { principalId: command.actorPrincipalId },
            nowEpochMs: read.authority.nowEpochMs
        });
        if (!policy.allowed) {
            const cause = new GroupPolicyDeniedError(policy);
            issues.push({ path: 'actor', message: cause.message, cause });
        }
    }
    if (!isValidRuntimeStateUpsertExpectedRevision(read.authorityGuard.entry.revision)) {
        const cause = new TypeError('Group topology authority update revision is invalid');
        issues.push({ path: 'read.authorityGuard.entry.revision', message: cause.message, cause });
    }
    try {
        const canonicalAuthorityWrite = materializeGroupStateAuthorityGuard(read.authorityGuard);
        const canonical = {
            ...computeGroupTopologyReconfigureMutation(command, read),
            authorityWrite: canonicalAuthorityWrite
        };
        issues.push(...validateAppInboxComputedProjection(canonical, computed, 'mutation'));
    }
    catch (caught) {
        const cause = caught instanceof Error ? caught : new Error(String(caught));
        issues.push({ path: 'mutation', message: cause.message, cause });
    }
    return issues;
}

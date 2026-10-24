import type { Group, GroupRef } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { AppInboxIdempotencyConflictError } from '../../app-inbox/app-inbox-contracts.ts';
import { validateComputedProjection, type ComputedDataValidationIssue } from '../../computed-data-validation.ts';
import { computeSha256CanonicalJson } from '../../protocol/canonical-json.ts';
import {
    requireEpoch,
    requireExactKeys,
    requirePositiveInteger,
    requireRecord,
    requireString
} from '../../protocol/exact-object-decoding.ts';
import { computeMutationCommandDigest, encodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import type {
    GroupMutationComputedWrite,
    GroupMutationIdempotencyRecord,
    GroupMutationReceipt
} from '../mutation/group-mutation-contracts.ts';
import { writeGroupMutation } from '../mutation/write/write-group-mutation.ts';
import type { GroupPresenceSummaryStoredRead } from '../persistence/group-state-repository-reads.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';
import { computeGroupRetention } from './compute-group-retention.ts';

export namespace GroupRetentionService {
    export interface Command {
        readonly groupRef: GroupRef;
        readonly requestId: string;
        readonly observedAtEpochMs: number;
    }

    export interface Ingress {
        readonly command: Command;
        readonly commandId: string;
        readonly commandHash: string;
        readonly eventId: string;
        readonly serviceId: string;
        readonly capturedAtEpochMs: number;
    }

    export interface Read {
        readonly ingress: Ingress;
        readonly attemptAtEpochMs: number;
        readonly attemptCount: number;
        readonly authority: Extract<GroupPresenceSummaryStoredRead, { status: 'stable'; }>;
        readonly idempotency: GroupMutationIdempotencyRecord | null;
    }

    export type Computed =
        | Readonly<{ outcome: 'absent'; receipt: null; }>
        | Readonly<{ outcome: 'no-op' | 'replay'; receipt: GroupMutationReceipt; }>
        | (
            & Pick<GroupMutationComputedWrite, 'persistence' | 'outboxWrites' | 'receipt'>
            & Readonly<{ outcome: 'write'; group: Group; }>
        );

    export interface Result {
        readonly groupRef: GroupRef;
        readonly receipt: GroupMutationReceipt | null;
    }

    export interface Dependencies {
        readonly repository: Pick<
            GroupStateRepository,
            'readPresenceSummaryEntries' | 'findIdempotentGroupMutationReceipt'
        >;
    }

    export interface Config {
        readonly serviceId: string;
        readonly now: () => number;
    }
}

/** Internal maintenance capability; AppInbox owns its transaction and fresh-attempt retry. */
export class GroupRetentionService {
    private readonly dependencies: GroupRetentionService.Dependencies;
    private readonly config: GroupRetentionService.Config;

    constructor(dependencies: GroupRetentionService.Dependencies, config: GroupRetentionService.Config) {
        this.dependencies = dependencies;
        this.config = config;
    }

    capture(command: GroupRetentionService.Command): GroupRetentionService.Ingress {
        const normalized = decodeGroupRetentionCommand(command);
        const commandHash = computeMutationCommandDigest(encodeJsonWireValue(normalized));
        return decodeGroupRetentionIngress({
            command: normalized,
            commandId: toGroupRetentionCommandId(normalized),
            commandHash,
            eventId: `group-retention-event:${commandHash.slice('sha256:'.length)}`,
            serviceId: this.config.serviceId,
            capturedAtEpochMs: this.config.now()
        });
    }

    async read(value: GroupRetentionService.Ingress, attemptCount: number): Promise<GroupRetentionService.Read> {
        const ingress = decodeGroupRetentionIngress(value);
        requirePositiveInteger(attemptCount, 'Retention attempt');
        const attemptAtEpochMs = Math.max(this.config.now(), ingress.capturedAtEpochMs);
        requireEpoch(attemptAtEpochMs, 'Retention attempt time');
        const [authority, idempotency] = await Promise.all([
            this.dependencies.repository.readPresenceSummaryEntries(ingress.command.groupRef),
            this.dependencies.repository.findIdempotentGroupMutationReceipt(ingress.command.groupRef, ingress.commandId)
        ]);
        if (authority.status !== 'stable') {
            throw new RuntimeStateWriteConflictError();
        }
        if (idempotency !== undefined && idempotency.commandHash !== ingress.commandHash) {
            throw new AppInboxIdempotencyConflictError(ingress.commandId, idempotency.commandHash, ingress.commandHash);
        }
        return { ingress, attemptAtEpochMs, attemptCount, authority, idempotency: idempotency ?? null };
    }

    compute(read: GroupRetentionService.Read): GroupRetentionService.Computed {
        return computeGroupRetention(read);
    }

    validate(
        read: GroupRetentionService.Read,
        computed: GroupRetentionService.Computed
    ): readonly ComputedDataValidationIssue[] {
        return validateComputedProjection(computeGroupRetention(read), computed, 'retention');
    }

    async write(transaction: PSqlSql, computed: GroupRetentionService.Computed): Promise<void> {
        if (computed.outcome === 'write') {
            await writeGroupMutation(transaction, computed);
        }
    }
}

export function decodeGroupRetentionCommand(value: unknown): GroupRetentionService.Command {
    const command = requireRecord(value, 'Retention command');
    requireExactKeys(command, ['groupRef', 'requestId', 'observedAtEpochMs'], 'Retention command');
    const ref = requireRecord(command.groupRef, 'Retention group reference');
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'groupId'], 'Retention group reference');
    requireString(ref.applicationId, 'Retention applicationId');
    requireString(ref.workspaceId, 'Retention workspaceId');
    requireString(ref.groupId, 'Retention groupId');
    requireString(command.requestId, 'Retention requestId');
    requireEpoch(command.observedAtEpochMs, 'Retention observation time');
    return {
        groupRef: { applicationId: ref.applicationId, workspaceId: ref.workspaceId, groupId: ref.groupId },
        requestId: command.requestId,
        observedAtEpochMs: Number(command.observedAtEpochMs)
    };
}

export function decodeGroupRetentionIngress(value: unknown): GroupRetentionService.Ingress {
    const ingress = requireRecord(value, 'Retention ingress');
    requireExactKeys(
        ingress,
        ['command', 'commandId', 'commandHash', 'eventId', 'serviceId', 'capturedAtEpochMs'],
        'Retention ingress'
    );
    const command = decodeGroupRetentionCommand(ingress.command);
    const commandHash = computeMutationCommandDigest(encodeJsonWireValue(command));
    requireString(ingress.serviceId, 'Retention serviceId');
    requireEpoch(ingress.capturedAtEpochMs, 'Retention ingress time');
    const normalized = {
        command,
        commandId: toGroupRetentionCommandId(command),
        commandHash,
        eventId: `group-retention-event:${commandHash.slice('sha256:'.length)}`,
        serviceId: ingress.serviceId,
        capturedAtEpochMs: Number(ingress.capturedAtEpochMs)
    };
    if (!jsonEquals(value, normalized) || normalized.capturedAtEpochMs < command.observedAtEpochMs) {
        throw new TypeError('Retention ingress identity or observation time is invalid');
    }
    return normalized;
}

function toGroupRetentionCommandId(command: GroupRetentionService.Command): string {
    return `group-retention:${
        computeSha256CanonicalJson({ groupRef: command.groupRef, requestId: command.requestId })
    }`;
}

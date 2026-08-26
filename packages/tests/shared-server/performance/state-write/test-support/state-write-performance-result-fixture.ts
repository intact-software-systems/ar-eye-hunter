import { createHash } from 'node:crypto';
import { PRODUCTION_STATE_WRITE_MUTATION_CONTRACT } from '../../../../../../scripts/perf/compare-api-v1-state-write-results.mjs';

type StateWriteMutationKind = keyof typeof PRODUCTION_STATE_WRITE_MUTATION_CONTRACT;

export interface StateWriteFixtureCommand {
    readonly kind: StateWriteMutationKind;
    readonly commandId: string;
}

export function binding(command: any, operationId: string): any {
    const topology = command.kind === 'topology-source';
    const requestId = command.kind === 'profile-instance'
        ? `${command.commandId}-${operationId}`
        : command.commandId;
    const receiptId = command.kind === 'profile-instance' || topology
        ? requestId
        : `group-app-inbox:${createHash('sha256').update(requestId).digest('hex')}`;
    const aggregateRef = command.kind === 'profile-instance'
        ? { applicationId: 'app', workspaceId: 'workspace', principalId: command.commandId }
        : { applicationId: 'app', workspaceId: 'workspace', groupId: command.commandId };
    return {
        operationId,
        receiptId,
        requestId,
        commandHash: `sha256:${'a'.repeat(64)}`,
        outcome: 'applied',
        attemptCount: 1,
        outboxIds: effectIds(command),
        aggregateRef,
        stateRevision: command.kind === 'profile-instance' ? 1 : null,
        causalRevision: command.kind === 'profile-instance' || topology
            ? null
            : { groupRevision: 1, presenceRevision: 0 },
        snapshotVersion: 1,
        acceptedVersion: topology ? 1 : null,
        operation: topology ? 'putConfig' : null,
        target: topology ? 'config' : null,
        acceptedStorageRevision: topology ? 1 : null,
        acceptedCreatedAtEpochMs: topology ? 1 : null,
        acceptedUpdatedAtEpochMs: topology ? 1 : null,
        acceptedExpiresAtEpochMs: null,
        acceptedConfig: topology ? topologyConfig() : null,
        acceptedCausalRevision: topology
            ? {
                causalRevision: { groupRevision: 1, presenceRevision: 0 },
                snapshotVersion: 1,
                metadataVersion: 1,
                rosterVersion: 0,
                presenceVersion: 0
            }
            : null,
        eventId: topology ? null : `${receiptId}:event`
    };
}

export function durableResult(command: any, operationId: string): any {
    const authoritative = binding(command, operationId);
    const outboxIds = effectIds(command);
    if (command.kind === 'topology-source') {
        const config = authoritative.acceptedConfig;
        return {
            receipt: {
                commandId: authoritative.receiptId,
                requestId: authoritative.requestId,
                commandHash: authoritative.commandHash,
                groupRef: authoritative.aggregateRef,
                acceptedVersion: authoritative.acceptedVersion,
                acceptedStorageRevision: authoritative.acceptedStorageRevision,
                acceptedCreatedAtEpochMs: authoritative.acceptedCreatedAtEpochMs,
                acceptedUpdatedAtEpochMs: authoritative.acceptedUpdatedAtEpochMs,
                acceptedExpiresAtEpochMs: authoritative.acceptedExpiresAtEpochMs,
                acceptedConfig: config,
                acceptedCausalRevision: authoritative.acceptedCausalRevision,
                eventId: authoritative.eventId,
                operation: authoritative.operation,
                target: authoritative.target,
                outcome: authoritative.outcome,
                attemptCount: authoritative.attemptCount,
                outboxIds: authoritative.outboxIds
            },
            config: {
                groupRef: authoritative.aggregateRef,
                config,
                version: authoritative.acceptedVersion,
                createdAtEpochMs: 1,
                updatedAtEpochMs: 1,
                updatedByPrincipalId: 'principal',
                requestId: authoritative.requestId
            }
        };
    }
    if (command.kind.startsWith('presence-')) {
        return {
            commandId: authoritative.receiptId,
            requestId: authoritative.requestId,
            commandHash: authoritative.commandHash,
            aggregateRef: authoritative.aggregateRef,
            snapshotVersion: authoritative.snapshotVersion,
            causalRevision: authoritative.causalRevision,
            eventId: authoritative.eventId,
            outcome: 'applied',
            attemptCount: 1,
            outboxIds
        };
    }
    const aggregateField = command.kind === 'profile-instance' ? 'principal' : 'group';
    return {
        status: 'ok',
        result: {
            snapshot: {
                ...(command.kind === 'profile-instance'
                    ? { stateRevision: authoritative.stateRevision }
                    : { causalRevision: authoritative.causalRevision }),
                [aggregateField]: {
                    ...authoritative.aggregateRef,
                    snapshotVersion: authoritative.snapshotVersion
                }
            },
            event: {
                ...authoritative.aggregateRef,
                eventId: authoritative.eventId,
                requestId: authoritative.requestId,
                snapshotVersion: authoritative.snapshotVersion
            }
        }
    };
}

function topologyConfig(): any {
    return {
        topologyKind: 'mesh',
        degreeLimit: 4,
        treeMinSize: 2,
        meshMinSize: 2,
        meshParamK: 2
    };
}

export function effectIds(command: StateWriteFixtureCommand): string[] {
    if (command.kind === 'topology-source') {
        return [`${command.commandId}:rtc-topology-recompute:group-revision:group=1;presence=0`];
    }
    return PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind]
        .map((_, index) => `${command.commandId}:effect:${index}`);
}

export function swapCompleteDurableResults(candidate: any, prefix: string): void {
    const candidates = candidate.workloads[0].samples[0].durableEvidence.appInbox.filter(
        (entry: any) => entry.commandType.startsWith(prefix) && entry.durableResult.status
    );
    const [first, second] = candidates.filter((entry: any) => entry.operationId === candidates[0].operationId);
    [first.durableResult, second.durableResult] = [second.durableResult, first.durableResult];
}

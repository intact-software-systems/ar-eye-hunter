import { hashRallarCrdtJson, toRallarCrdtDocumentKey, type RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';

import { requireEpoch, requireExactKeys, requireOneOf, requireString } from '../../protocol/exact-object-decoding.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type {
    CrdtLifecycleFieldAction,
    CrdtMutationCommand,
    CreateCrdtMutationCommandInput
} from './crdt-mutation-contracts.ts';
import { decodeExactUpdateEnvelope } from './decode-exact-update-envelope.ts';
import { decodeExactDocumentRef } from './decoding/decode-exact-document-ref.ts';
import { decodeExactProjectionIds } from './decoding/decode-exact-projection-ids.ts';
import { decodeExactQuotaPolicy } from './decoding/decode-exact-quota-policy.ts';
import { decodeExactRetentionPolicy } from './decoding/decode-exact-retention-policy.ts';
import { decodeExactSnapshotEnvelope } from './decoding/decode-exact-snapshot-envelope.ts';
import { requireCrdtJsonWireObject } from './decoding/require-crdt-json-wire-object.ts';
import { requireCrdtCanonicalSnapshotReason, toCrdtCanonicalSnapshotEnvelope } from './to-crdt-canonical-snapshot.ts';

export async function createCrdtMutationCommand(
    input: CreateCrdtMutationCommandInput
): Promise<CrdtMutationCommand> {
    const canonicalInput = input.operation === 'compact' ? toCanonicalCompactCommandInput(input) : input;
    const stable = {
        ...canonicalInput,
        deliveryId: canonicalInput.deliveryId ?? canonicalInput.commandId,
        documentKey: toRallarCrdtDocumentKey(canonicalInput.document),
        version: 1 as const
    };
    return decodeCrdtMutationCommand({
        ...stable,
        commandHash: hashRallarCrdtJson(stable)
    });
}

export function decodeCrdtMutationCommand(value: unknown): CrdtMutationCommand {
    const command = requireCrdtJsonWireObject(
        decodeJsonWireValue(value, 'CRDT mutation command'),
        'CRDT mutation command'
    );
    const operation = requireOneOf(
        command.operation,
        ['append', 'rebuild-projection', 'compact', 'lifecycle', 'erase'] as const,
        'CRDT mutation operation'
    );
    const allowed = commonCommandKeys.concat(
        operation === 'append'
            ? ['update', 'authorizationScope']
            : operation === 'rebuild-projection'
            ? ['projectionId']
            : operation === 'compact'
            ? ['snapshotId', 'snapshot', 'reason']
            : operation === 'lifecycle'
            ? ['lifecycle', 'retentionAction', 'quotaAction', 'projectionIdsAction']
            : ['mode', 'reason']
    );
    requireExactKeys(command, allowed, 'CRDT mutation command');
    if (command.version !== 1) {
        throw new TypeError('CRDT mutation version is invalid');
    }
    requireString(command.commandId, 'commandId');
    requireString(command.deliveryId, 'deliveryId');
    requireString(command.commandHash, 'commandHash');
    requireEpoch(command.capturedAtEpochMs, 'capturedAtEpochMs');
    requireEpoch(command.expireAtEpochMs, 'expireAtEpochMs');
    if ((command.expireAtEpochMs as number) <= (command.capturedAtEpochMs as number)) {
        throw new TypeError('CRDT mutation expiry must follow capture time');
    }
    const actor = requireCrdtJsonWireObject(command.actor, 'CRDT mutation actor');
    requireExactKeys(actor, ['actorId', 'principalId', 'sessionId', 'serverId'], 'actor');
    const actorId = actor.actorId;
    const principalId = actor.principalId;
    const sessionId = actor.sessionId;
    const serverId = actor.serverId;
    requireString(actorId, 'actor field');
    requireString(principalId, 'actor field');
    requireString(sessionId, 'actor field');
    requireString(serverId, 'actor field');
    const audience = requireCrdtJsonWireObject(
        command.responseAudience,
        'CRDT response audience'
    );
    requireExactKeys(
        audience,
        ['kind', 'senderSessionId', 'topicId', 'contextId'],
        'responseAudience'
    );
    requireOneOf(audience.kind, ['room', 'principal', 'app', 'admin'] as const, 'audience kind');
    requireString(audience.senderSessionId, 'senderSessionId');
    requireString(audience.topicId, 'topicId');
    requireString(audience.contextId, 'contextId');
    const document = decodeExactDocumentRef(command.document, 'CRDT command document');
    if (toRallarCrdtDocumentKey(document) !== command.documentKey) {
        throw new TypeError('CRDT command document key differs from document');
    }
    const common = {
        version: 1 as const,
        commandId: command.commandId,
        deliveryId: command.deliveryId,
        commandHash: command.commandHash,
        actor: {
            actorId,
            principalId,
            sessionId,
            serverId
        },
        capturedAtEpochMs: Number(command.capturedAtEpochMs),
        expireAtEpochMs: Number(command.expireAtEpochMs),
        document,
        documentKey: command.documentKey,
        responseAudience: {
            kind: requireOneOf(
                audience.kind,
                ['room', 'principal', 'app', 'admin'] as const,
                'audience kind'
            ),
            senderSessionId: audience.senderSessionId,
            topicId: audience.topicId,
            contextId: audience.contextId
        }
    };
    if (operation === 'append') {
        const update = decodeExactUpdateEnvelope(command.update);
        if (toRallarCrdtDocumentKey(update.document) !== toRallarCrdtDocumentKey(document)) {
            throw new TypeError('CRDT update document differs');
        }
        const authorizationScope = requireOneOf(
            command.authorizationScope,
            ['room', 'principal', 'app', 'custom'] as const,
            'authorizationScope'
        );
        return completeCommand(command, { ...common, operation, update, authorizationScope });
    }
    else if (operation === 'rebuild-projection') {
        requireString(command.projectionId, 'projectionId');
        return completeCommand(command, { ...common, operation, projectionId: command.projectionId });
    }
    else if (operation === 'compact') {
        requireString(command.snapshotId, 'snapshotId');
        const rawSnapshot = command.snapshot === null
            ? null
            : decodeExactSnapshotEnvelope(requireCommandValue(command.snapshot, 'snapshot'));
        if (
            rawSnapshot !== null &&
            toRallarCrdtDocumentKey(rawSnapshot.document) !== toRallarCrdtDocumentKey(document)
        ) {
            throw new TypeError('CRDT compact snapshot document differs from command document');
        }
        if (rawSnapshot !== null && rawSnapshot.snapshotId !== command.snapshotId) {
            throw new TypeError('CRDT compact snapshot ID differs from command input');
        }
        requireCrdtCanonicalSnapshotReason(command.reason);
        if (rawSnapshot !== null && rawSnapshot.metadata.reason !== command.reason) {
            throw new TypeError('CRDT compact snapshot reason differs from command reason');
        }
        const snapshot = rawSnapshot === null ? null : toCrdtCanonicalSnapshotEnvelope(rawSnapshot, command.reason);
        return completeCommand(command, {
            ...common,
            operation,
            snapshotId: command.snapshotId,
            snapshot,
            reason: command.reason
        });
    }
    else if (operation === 'lifecycle') {
        const lifecycle = requireOneOf(
            command.lifecycle,
            ['active', 'archived', 'destroyed', 'quarantined'] as const,
            'lifecycle'
        );
        return completeCommand(command, {
            ...common,
            operation,
            lifecycle,
            retentionAction: decodeRetentionAction(command.retentionAction),
            quotaAction: decodeQuotaAction(command.quotaAction),
            projectionIdsAction: decodeProjectionIdsAction(command.projectionIdsAction)
        });
    }
    else {
        const mode = requireOneOf(
            command.mode,
            ['destroy-document', 'redact-payloads'] as const,
            'erase mode'
        );
        requireString(command.reason, 'reason');
        return completeCommand(command, { ...common, operation, mode, reason: command.reason });
    }
}

function completeCommand<T extends CrdtMutationCommand>(
    rawCommand: JsonWireObject,
    command: T
): T {
    const { commandHash: _hash, ...stable } = rawCommand;
    if (hashRallarCrdtJson(stable) !== rawCommand.commandHash) {
        throw new TypeError('CRDT mutation command hash differs from canonical command');
    }
    return command;
}

function toCanonicalCompactCommandInput(
    input: Extract<CreateCrdtMutationCommandInput, { operation: 'compact'; }>
): CreateCrdtMutationCommandInput {
    requireString(input.reason, 'reason');
    return {
        ...input,
        snapshot: input.snapshot === null
            ? null
            : toCrdtCanonicalSnapshotEnvelope(input.snapshot, input.reason)
    };
}

function decodeRetentionAction(value: JsonWireValue | undefined) {
    const action = decodeLifecycleActionValue(value, 'retention');
    return action.kind === 'set'
        ? { kind: action.kind, value: decodeExactRetentionPolicy(action.value) }
        : action;
}

function decodeQuotaAction(value: JsonWireValue | undefined) {
    const action = decodeLifecycleActionValue(value, 'quota');
    return action.kind === 'set'
        ? { kind: action.kind, value: decodeExactQuotaPolicy(action.value) }
        : action;
}

function decodeProjectionIdsAction(value: JsonWireValue | undefined) {
    const action = decodeLifecycleActionValue(value, 'projectionIds');
    return action.kind === 'set'
        ? { kind: action.kind, value: decodeExactProjectionIds(action.value) }
        : action;
}

function decodeLifecycleActionValue(
    value: JsonWireValue | undefined,
    label: string
): CrdtLifecycleFieldAction<JsonWireValue> {
    const action = requireCrdtJsonWireObject(value, `${label} action`);
    const kind = requireOneOf(
        action.kind,
        ['preserve', 'clear', 'set'] as const,
        `${label} action kind`
    );
    requireExactKeys(action, kind === 'set' ? ['kind', 'value'] : ['kind'], `${label} action`);
    if (kind === 'preserve') {
        return { kind };
    }
    if (kind === 'clear') {
        return { kind };
    }
    if (action.value === null || action.value === undefined) {
        throw new TypeError(`${label} action value is invalid`);
    }
    return { kind, value: action.value };
}

function requireCommandValue(
    value: JsonWireValue | undefined,
    label: string
): JsonWireValue {
    if (value === undefined) {
        throw new TypeError(`CRDT mutation command ${label} is missing`);
    }
    return value;
}

const commonCommandKeys = [
    'version',
    'operation',
    'commandId',
    'deliveryId',
    'commandHash',
    'actor',
    'capturedAtEpochMs',
    'expireAtEpochMs',
    'document',
    'documentKey',
    'responseAudience'
];

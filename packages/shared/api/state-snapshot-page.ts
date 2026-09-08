import type { ALMessage } from '../al-contracts/al-contract.ts';
import { decodeALMessageValue, type ALMessageRejection } from '../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../al-contracts/al-message-resource-limits.ts';
import { fnv1a64 } from '../queuebox/AppQueueIdentity.ts';
import { Either } from '../resilience/Either.ts';
import { AppTopics } from './api-config.ts';
import type { GroupStateCausalRevision } from './group-types.ts';
import type { StateScope } from './state-types.ts';

export const STATE_SNAPSHOT_LIMITS = {
    snapshotBytes: 16 * 1024 * 1024,
    pages: 256,
    transfers: 8,
    aggregateBytes: 32 * 1024 * 1024,
    assemblyMs: 30_000,
    chunkBytes: 48 * 1024
} as const;

export interface StateSnapshotScope extends StateScope {
    readonly kind: 'group' | 'principal';
    readonly resourceId: string;
}

/** Publication data is not a wire AL envelope until its payload and audience are paged. */
export interface StateSnapshotEnvelope {
    readonly id: ALMessage['id'];
    readonly route: ALMessage['route'];
    readonly targets: ALMessage['targets'];
    readonly constraints: ALMessage['constraints'];
    readonly delivery: ALMessage['delivery'];
    readonly audit: ALMessage['audit'];
}

export interface StateSnapshotPublication {
    readonly envelope: StateSnapshotEnvelope;
    readonly scope: StateSnapshotScope;
    readonly revision: string;
    readonly resource: string;
    readonly unicastPeerIds?: readonly string[];
    readonly roomRecipientPeerIds?: readonly string[];
}

export interface StateSnapshotPage {
    readonly kind: 'state-snapshot-page';
    readonly scope: StateSnapshotScope;
    readonly transferId: string;
    readonly originalMessageId: string;
    readonly revision: string;
    readonly topicId: string;
    readonly typeId: string;
    readonly index: number;
    readonly count: number;
    readonly totalBytes: number;
    readonly expiresAtMs: number;
    /** Consistency checksum only; server provenance and domain validation establish authority. */
    readonly checksum: string;
    readonly chunk: string;
}

export interface CompletedStateSnapshot {
    readonly page: StateSnapshotPage;
    readonly envelope: ALMessage;
    readonly resource: string;
}

export function isStateSnapshotTopic(topicId: string): boolean {
    return topicId === AppTopics.groupStateSnapshot || topicId === AppTopics.groupDirectorySnapshot ||
        topicId === AppTopics.clientStateSnapshot || topicId === AppTopics.overlayTopology;
}

export function decodeGroupSnapshotPageRevision(
    page: StateSnapshotPage
): Either<ALMessageRejection, GroupStateCausalRevision> {
    const matched = /^group=(0|[1-9]\d*);presence=(0|[1-9]\d*)$/u.exec(page.revision);
    if (
        page.scope.kind !== 'group' || !matched ||
        !Number.isSafeInteger(Number(matched[1])) || !Number.isSafeInteger(Number(matched[2]))
    ) {
        return rejectSnapshotPage('malformed', 'Group snapshot page revision is invalid');
    }
    return Either.ofRight({ groupRevision: Number(matched[1]), presenceRevision: Number(matched[2]) });
}

export function computeStateSnapshotPages(
    publication: StateSnapshotPublication
): Either<ALMessageRejection, readonly ALMessage[]> {
    const issue = validateSnapshotPublication(publication);
    if (issue) {
        return Either.ofLeft(issue);
    }
    const chunks = splitSnapshotResource(publication.resource);
    if (chunks.length > STATE_SNAPSHOT_LIMITS.pages) {
        return rejectSnapshotPage('oversized', 'Snapshot exceeds the page budget');
    }
    const checksum = fnv1a64(publication.resource);
    const totalBytes = new TextEncoder().encode(publication.resource).length;
    const pages = chunks.map((chunk, index): StateSnapshotPage => ({
        kind: 'state-snapshot-page',
        scope: { ...publication.scope },
        transferId: snapshotTransferId(
            JSON.stringify([publication.envelope.id.senderId, publication.envelope.id.msgId]),
            publication.scope,
            [publication.revision, checksum, String(publication.envelope.constraints!.expiresAtMs)]
        ),
        originalMessageId: publication.envelope.id.msgId,
        revision: publication.revision,
        topicId: publication.envelope.route.topicId,
        typeId: publication.envelope.route.topicId,
        index,
        count: chunks.length,
        totalBytes,
        expiresAtMs: publication.envelope.constraints!.expiresAtMs!,
        checksum,
        chunk
    }));
    return materializeSnapshotPageEnvelopes(publication, pages);
}

function validateSnapshotPublication(publication: StateSnapshotPublication): ALMessageRejection | undefined {
    if (!isStateSnapshotTopic(publication.envelope.route.topicId) || !validSnapshotScope(publication.scope)) {
        return { code: 'malformed', message: 'Snapshot publication scope or topic is invalid' };
    }
    const expiry = publication.envelope.constraints?.expiresAtMs;
    if (!Number.isSafeInteger(expiry) || expiry! <= publication.envelope.id.ts || !publication.revision) {
        return { code: 'malformed', message: 'Snapshot publication revision or expiry is invalid' };
    }
    if (new TextEncoder().encode(publication.resource).length > STATE_SNAPSHOT_LIMITS.snapshotBytes) {
        return { code: 'oversized', message: 'Snapshot exceeds the byte budget' };
    }
    try {
        JSON.parse(publication.resource);
    }
    catch {
        return { code: 'malformed', message: 'Snapshot resource must contain JSON' };
    }
    return undefined;
}

function splitSnapshotResource(resource: string): readonly string[] {
    const chunks: string[] = [];
    let offset = 0;
    let end = 0;
    let bytes = 0;
    for (const character of resource) {
        const point = character.codePointAt(0)!;
        const size = character === '"' || character === '\\'
            ? 2
            : point <= 0x7f
            ? 1
            : point <= 0x7ff
            ? 2
            : point <= 0xffff
            ? 3
            : 4;
        if (bytes + size > STATE_SNAPSHOT_LIMITS.chunkBytes) {
            chunks.push(resource.slice(offset, end));
            offset = end;
            bytes = 0;
        }
        bytes += size;
        end += character.length;
    }
    chunks.push(resource.slice(offset));
    return chunks;
}

function materializeSnapshotPageEnvelopes(
    publication: StateSnapshotPublication,
    pages: readonly StateSnapshotPage[]
): Either<ALMessageRejection, readonly ALMessage[]> {
    const messages: ALMessage[] = [];
    const envelope = publication.envelope;
    const roomTargets = envelope.targets?.mode === 'broadcast' && envelope.targets.scope === 'room' &&
            publication.roomRecipientPeerIds?.length
        ? computeSnapshotAudienceBatches({ ...envelope.targets, recipientPeerIds: publication.roomRecipientPeerIds })
        : [];
    const targets = [
        ...computeSnapshotAudienceBatches(envelope.targets),
        ...roomTargets,
        ...(publication.unicastPeerIds ?? []).map((toPeerId) => ({ mode: 'unicast' as const, toPeerId }))
    ];
    for (const [batch, audience] of targets.entries()) {
        for (const page of pages) {
            const result = decodeALMessageValue({
                ...envelope,
                id: { ...envelope.id, msgId: JSON.stringify(['snapshot-page', page.transferId, batch, page.index]) },
                targets: audience,
                payload: { typeId: page.typeId, contentType: 'application/json', resource: JSON.stringify(page) }
            });
            if (result.left) {
                return Either.ofLeft(result.left);
            }
            messages.push(result.right!);
        }
    }
    return Either.ofRight(messages);
}

function computeSnapshotAudienceBatches(targets: ALMessage['targets']): readonly ALMessage['targets'][] {
    if (targets?.mode !== 'broadcast' || targets.recipientPeerIds === undefined) {
        return [targets];
    }
    const batches: ALMessage['targets'][] = [];
    const ids = targets.recipientPeerIds;
    for (let offset = 0; offset < ids.length; offset += AL_MESSAGE_RESOURCE_LIMITS.collectionEntries) {
        batches.push({
            ...targets,
            recipientPeerIds: ids.slice(offset, offset + AL_MESSAGE_RESOURCE_LIMITS.collectionEntries)
        });
    }
    return batches.length > 0 ? batches : [{ ...targets, recipientPeerIds: [] }];
}

export function decodeStateSnapshotPage(
    message: ALMessage,
    scope: StateScope
): Either<ALMessageRejection, StateSnapshotPage> {
    const decoded = decodeALMessageValue(message);
    if (decoded.left) {
        return Either.ofLeft(decoded.left);
    }
    try {
        const page: unknown = JSON.parse(message.payload.resource);
        if (!isSnapshotPage(page)) {
            return rejectSnapshotPage('malformed', 'Snapshot page fields are invalid');
        }
        if (page.scope.applicationId !== scope.applicationId || page.scope.workspaceId !== scope.workspaceId) {
            return rejectSnapshotPage('unauthorized', 'Snapshot page belongs to another scope');
        }
        if (!snapshotPageMatchesEnvelope(page, message)) {
            return rejectSnapshotPage('malformed', 'Snapshot page differs from its envelope');
        }
        return Either.ofRight(page);
    }
    catch {
        return rejectSnapshotPage('malformed', 'Snapshot page must contain JSON');
    }
}

function isSnapshotPage(value: unknown): value is StateSnapshotPage {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const page = value as Record<string, unknown>;
    const fields = [
        'kind',
        'scope',
        'transferId',
        'originalMessageId',
        'revision',
        'topicId',
        'typeId',
        'index',
        'count',
        'totalBytes',
        'expiresAtMs',
        'checksum',
        'chunk'
    ];
    if (Object.keys(page).length !== fields.length || fields.some((key) => !Object.hasOwn(page, key))) {
        return false;
    }
    if (page.kind !== 'state-snapshot-page' || !validSnapshotScope(page.scope)) {
        return false;
    }
    if (
        ['transferId', 'originalMessageId', 'revision', 'topicId', 'typeId', 'checksum'].some((key) =>
            typeof page[key] !== 'string' || page[key].length === 0
        )
    ) {
        return false;
    }
    if (
        typeof page.chunk !== 'string' ||
        new TextEncoder().encode(JSON.stringify(page.chunk)).length > STATE_SNAPSHOT_LIMITS.chunkBytes + 2
    ) {
        return false;
    }
    return validPageInteger(page.count, 1, STATE_SNAPSHOT_LIMITS.pages) &&
        validPageInteger(page.index, 0, Number(page.count) - 1) &&
        validPageInteger(page.totalBytes, 1, STATE_SNAPSHOT_LIMITS.snapshotBytes) &&
        validPageInteger(page.expiresAtMs, 0, Number.MAX_SAFE_INTEGER);
}

function snapshotPageMatchesEnvelope(page: StateSnapshotPage, message: ALMessage): boolean {
    if (message.audit?.createdBy !== message.id.senderId || message.ordering) {
        return false;
    }
    if (
        !isStateSnapshotTopic(page.topicId) || page.topicId !== page.typeId ||
        page.topicId !== message.route.topicId || page.typeId !== message.payload.typeId ||
        page.expiresAtMs !== message.constraints?.expiresAtMs
    ) {
        return false;
    }
    if ((page.typeId === AppTopics.clientStateSnapshot) !== (page.scope.kind === 'principal')) {
        return false;
    }
    if (
        page.transferId !==
            snapshotTransferId(JSON.stringify([message.id.senderId, page.originalMessageId]), page.scope, [
                page.revision,
                page.checksum,
                String(page.expiresAtMs)
            ]) ||
        !matchesPageMessageId(message.id.msgId, page)
    ) {
        return false;
    }
    const targets = message.targets;
    if (targets?.mode === 'broadcast' && targets.scope === 'room') {
        return page.scope.kind === 'group' && targets.groupRef?.applicationId === page.scope.applicationId &&
            targets.groupRef.workspaceId === page.scope.workspaceId &&
            targets.groupRef.groupId === page.scope.resourceId;
    }
    if (targets?.mode === 'broadcast' && targets.scope === 'principal') {
        return page.scope.kind === 'principal' && targets.principalRef?.applicationId === page.scope.applicationId &&
            targets.principalRef.workspaceId === page.scope.workspaceId &&
            targets.principalRef.principalId === page.scope.resourceId;
    }
    return targets?.mode === 'unicast';
}

function validSnapshotScope(value: unknown): value is StateSnapshotScope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const scope = value as Record<string, unknown>;
    return Object.keys(scope).length === 4 && (scope.kind === 'group' || scope.kind === 'principal') &&
        ['applicationId', 'workspaceId', 'resourceId'].every((key) =>
            typeof scope[key] === 'string' && scope[key].length > 0
        );
}

function validPageInteger(value: unknown, min: number, max: number): boolean {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function rejectSnapshotPage<R>(
    code: ALMessageRejection['code'],
    message: string
): Either<ALMessageRejection, R> {
    return Either.ofLeft({ code, message });
}

function snapshotTransferId(messageId: string, scope: StateSnapshotScope, commitment: readonly string[]): string {
    return JSON.stringify([
        messageId,
        [scope.kind, scope.applicationId, scope.workspaceId, scope.resourceId],
        ...commitment
    ]);
}

function matchesPageMessageId(messageId: string, page: StateSnapshotPage): boolean {
    try {
        const id: unknown = JSON.parse(messageId);
        return Array.isArray(id) && id.length === 4 && id[0] === 'snapshot-page' && id[1] === page.transferId &&
            validPageInteger(id[2], 0, Number.MAX_SAFE_INTEGER) && id[3] === page.index;
    }
    catch {
        return false;
    }
}

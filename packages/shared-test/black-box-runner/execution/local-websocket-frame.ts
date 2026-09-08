import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    decodeALMessageValue,
    type ALMessageRejection
} from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    AL_MESSAGE_RESOURCE_LIMITS,
    validateSerializedALMessageSize
} from '@shared/al-contracts/al-message-resource-limits.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import {
    parseAuthoritativeClientSnapshot,
    parseAuthoritativeGroupSnapshot,
    parseAuthoritativeOverlayTopologySnapshot
} from '@shared/api/authoritative-state-validation.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    decodeStateSnapshotPage,
    isStateSnapshotTopic,
    type CompletedStateSnapshot,
    type StateSnapshotPage
} from '@shared/api/state-snapshot-page.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { StateSnapshotAssembly } from '@shared/services/state-snapshot-assembly.ts';

interface LocalWsCompletedSnapshot {
    readonly topicId: string;
    readonly typeId: string;
    readonly originalMessageId: string;
    readonly scope: StateSnapshotPage['scope'];
    readonly revision: string;
    readonly route: ALMessage['route'];
    readonly targets: ALMessage['targets'];
    readonly snapshot: ClientSnapshot | GroupSnapshot | RallarOverlayTopologySnapshot;
}

export interface LocalWsMessage {
    readonly data: unknown;
    readonly wireFrame?: string | Blob | ArrayBuffer;
    readonly rejection?: ALMessageRejection;
    readonly receivedAtEpochMs: number;
    readonly retainedBytes: number;
}

function computeCompletedSnapshot(
    completed: CompletedStateSnapshot,
    scope: StateScope
): Either<ALMessageRejection, LocalWsCompletedSnapshot> {
    const { page, envelope, resource } = completed;
    try {
        let snapshot: LocalWsCompletedSnapshot['snapshot'];
        let resourceId: string;
        let revision: string;
        let kind: StateSnapshotPage['scope']['kind'];
        if (page.topicId === AppTopics.clientStateSnapshot) {
            const client = parseAuthoritativeClientSnapshot(resource, scope);
            snapshot = client;
            resourceId = client.principal.principalId;
            revision = `revision=${client.stateRevision}`;
            kind = 'principal';
        }
        else if (page.topicId === AppTopics.overlayTopology) {
            const topology = parseAuthoritativeOverlayTopologySnapshot(resource, scope);
            snapshot = topology;
            resourceId = topology.groupRef.groupId;
            revision = JSON.stringify([
                topology.sourceGroupStateCausalRevision.groupRevision,
                topology.sourceGroupStateCausalRevision.presenceRevision,
                topology.version
            ]);
            kind = 'group';
        }
        else {
            const group = parseAuthoritativeGroupSnapshot(resource, scope);
            snapshot = group;
            resourceId = group.group.groupId;
            revision = `group=${group.causalRevision.groupRevision};presence=${group.causalRevision.presenceRevision}`;
            kind = 'group';
        }
        if (page.scope.kind !== kind || page.scope.resourceId !== resourceId || page.revision !== revision) {
            return Either.ofLeft({
                code: 'malformed',
                message: 'Completed snapshot identity or revision does not match its pages'
            });
        }
        return Either.ofRight({
            topicId: page.topicId,
            typeId: page.typeId,
            originalMessageId: page.originalMessageId,
            scope: page.scope,
            revision: page.revision,
            route: envelope.route,
            targets: envelope.targets,
            snapshot
        });
    }
    catch (error) {
        return Either.ofLeft({ code: 'malformed', message: error instanceof Error ? error.message : String(error) });
    }
}

export interface LocalWsFrameInput {
    readonly maxRetainedBytes: number;
    readonly value: unknown;
    readonly scope: StateScope | undefined;
    readonly assembly: StateSnapshotAssembly;
    readonly nowMs: number;
}

function measureWsFrameBytes(value: string | Blob | ArrayBuffer, maxBytes: number): number {
    if (typeof value === 'string') {
        return value.length > maxBytes ? maxBytes + 1 : new TextEncoder().encode(value).byteLength;
    }
    return value instanceof Blob ? value.size : value.byteLength;
}

export function acceptLocalWsFrame(input: LocalWsFrameInput): readonly LocalWsMessage[] {
    const { value, scope, assembly, nowMs } = input;
    if (typeof value !== 'string' && !(value instanceof Blob) && !(value instanceof ArrayBuffer)) {
        return [{
            data: undefined,
            rejection: { code: 'unsupported', message: 'WebSocket observation requires a native text or binary frame' },
            receivedAtEpochMs: nowMs,
            retainedBytes: 256
        }];
    }
    const frameBudget = scope ? AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes : input.maxRetainedBytes;
    const nativeBytes = measureWsFrameBytes(value, frameBudget);
    const reject = (rejection: ALMessageRejection): readonly LocalWsMessage[] => [{
        data: undefined,
        wireFrame: nativeBytes <= AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes ? value : undefined,
        rejection,
        receivedAtEpochMs: nowMs,
        retainedBytes: Math.min(nativeBytes, AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes) + 256
    }];
    if (scope) {
        if (nativeBytes > AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes) {
            return reject({ code: 'oversized', message: 'WebSocket ALM frame exceeds the envelope byte limit' });
        }
        if (typeof value === 'string') {
            const sizeIssue = validateSerializedALMessageSize(value)[0];
            if (sizeIssue) {
                return reject(sizeIssue);
            }
        }
    }
    if (nativeBytes * 2 > input.maxRetainedBytes) {
        return reject({ code: 'oversized', message: 'WebSocket frame exceeds the observation retention budget' });
    }
    let data: unknown = value;
    if (typeof value === 'string') {
        try {
            data = JSON.parse(value);
        }
        catch {
            if (scope) {
                return reject({ code: 'malformed', message: 'WebSocket ALM frame is not JSON' });
            }
        }
    }
    if (!scope) {
        return [{ data, wireFrame: value, receivedAtEpochMs: nowMs, retainedBytes: nativeBytes * 2 }];
    }
    if (typeof value !== 'string') {
        return reject({ code: 'unsupported', message: 'WebSocket ALM frames must be JSON text' });
    }
    const decoded = decodeALMessageValue(data);
    if (decoded.left) {
        return reject(decoded.left);
    }
    const message = decoded.right!;
    return acceptWsSnapshot({ message, wireFrame: value, wireBytes: nativeBytes, scope, assembly, nowMs });
}

interface LocalWsSnapshotInput {
    readonly message: ALMessage;
    readonly wireFrame: string;
    readonly wireBytes: number;
    readonly scope: StateScope;
    readonly assembly: StateSnapshotAssembly;
    readonly nowMs: number;
}

function acceptWsSnapshot(input: LocalWsSnapshotInput): readonly LocalWsMessage[] {
    const { message, wireFrame, wireBytes, scope, assembly, nowMs } = input;
    if (!isStateSnapshotTopic(message.route.topicId)) {
        return [{ data: message, wireFrame, receivedAtEpochMs: nowMs, retainedBytes: wireBytes * 2 }];
    }
    const decodedPage = decodeStateSnapshotPage(message, scope);
    const page = decodedPage.right;
    const raw: LocalWsMessage = {
        data: page
            ? {
                observedSnapshotPage: {
                    scope: page.scope,
                    topicId: page.topicId,
                    typeId: page.typeId,
                    revision: page.revision,
                    transferId: page.transferId
                }
            }
            : undefined,
        wireFrame,
        receivedAtEpochMs: nowMs,
        retainedBytes: wireBytes * 2
    };
    if (decodedPage.left) {
        return [{ ...raw, rejection: decodedPage.left }];
    }
    const accepted = assembly.accept({ message, scope, nowMs });
    if (accepted.left) {
        return [{ ...raw, rejection: accepted.left }];
    }
    if (accepted.right!.kind !== 'complete') {
        return [raw];
    }
    const completed = accepted.right!.snapshot;
    const projection = computeCompletedSnapshot(completed, scope);
    if (projection.left) {
        return [{ ...raw, rejection: projection.left }];
    }
    return [raw, {
        data: { completedSnapshot: projection.right! },
        receivedAtEpochMs: nowMs,
        retainedBytes: completed.page.totalBytes
    }];
}

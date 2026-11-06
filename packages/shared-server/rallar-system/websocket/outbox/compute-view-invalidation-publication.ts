import { Temporal } from '@js-temporal/polyfill';
import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import { decodeViewInvalidation, type ViewInvalidation } from '@shared/api/views/view-invalidation.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { computeAppOutboxInsert, type AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import { computeWsOutboxProvenanceRecord } from './ws-outbox-provenance.ts';

export type ViewInvalidationPublicationInput =
    & ViewInvalidationPublicationFacts
    & (
        | (
            & (
                | Pick<ViewInvalidation.ScopedAccount, 'resource' | 'scope'>
                | Pick<ViewInvalidation.Account, 'resource' | 'scope'>
            )
            & { readonly principalIds: readonly string[]; }
        )
        | (Pick<ViewInvalidation.PublicCatalog, 'resource' | 'scope'> & { readonly principalIds: null; })
    );

interface ViewInvalidationPublicationFacts {
    readonly changeId: string;
    readonly createdAtEpochMs: number;
    readonly retentionMs: number;
    readonly serviceId: string;
    readonly traceId: string;
}

export interface ViewInvalidationPublication {
    readonly outbox: readonly AppOutboxInsert[];
    readonly provenance: readonly RuntimeStateGuardedBatchEffect[];
}

/** Final rows are computed with state; own-session resolution happens only after the commit. */
export function computeViewInvalidationPublication(
    input: ViewInvalidationPublicationInput
): ViewInvalidationPublication {
    const outbox: AppOutboxInsert[] = [];
    const provenance: RuntimeStateGuardedBatchEffect[] = [];
    for (const principalId of input.principalIds === null ? [null] : [...new Set(input.principalIds)].sort()) {
        const notice = decodeViewInvalidation({
            version: 1,
            resource: input.resource,
            scope: input.scope,
            principalId,
            changeId: input.changeId
        });
        const message = toViewInvalidationMessage(input, notice);
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(
            message,
            EnqueuedType.WS_OUTBOX,
            Temporal.Instant.fromEpochMilliseconds(input.createdAtEpochMs)
        );
        const record = computeWsOutboxProvenanceRecord({
            producerKind: 'view-invalidation',
            entry,
            message,
            expiresAtMs: input.createdAtEpochMs + input.retentionMs,
            target: notice.principalId === null
                ? { kind: 'scoped-world-broadcast', scope: notice.scope }
                : notice.scope === null
                ? { kind: 'account-view', accountView: { version: 1, principalId: notice.principalId } }
                : { kind: 'scoped-account-view', principalRef: { ...notice.scope, principalId: notice.principalId } }
        });
        provenance.push({ effectId: `view:${entry.key.resourceId}`, operation: 'insert', ...record });
        outbox.push(computeAppOutboxInsert(entry));
    }
    return { outbox, provenance };
}

function toViewInvalidationMessage(input: ViewInvalidationPublicationInput, notice: ViewInvalidation): ALMessage {
    const identity = computeSha256CanonicalJson(notice);
    const route = toAppQueueKey({
        topicId: AppTopics.viewInvalidated,
        resourceId: identity,
        contextId: notice.principalId === null
            ? notice.scope.applicationId
            : computeSha256CanonicalJson({ scope: input.scope, principalId: notice.principalId })
    });
    return decodePersistedALMessageValue({
        id: {
            v: AL_MESSAGE_ENVELOPE_VERSION,
            msgId: identity,
            ts: input.createdAtEpochMs,
            senderId: input.serviceId,
            traceId: input.traceId
        },
        route,
        targets: notice.principalId === null
            ? { mode: 'broadcast', scope: 'world' }
            : notice.scope === null
            ? { mode: 'unicast', toPeerId: notice.principalId }
            : {
                mode: 'broadcast',
                scope: 'principal',
                principalRef: { ...input.scope, principalId: notice.principalId }
            },
        constraints: { expiresAtMs: input.createdAtEpochMs + input.retentionMs },
        delivery: { ownership: 'shared', reliability: 'at-least-once', ack: 'none' },
        payload: {
            typeId: AppTopics.viewInvalidated,
            contentType: 'application/json',
            resource: JSON.stringify(notice)
        },
        audit: { createdBy: input.serviceId, createdTs: input.createdAtEpochMs }
    });
}

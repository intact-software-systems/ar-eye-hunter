import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import {
    createAppInboxResourceEntry,
    createDefaultAppInboxQueueMessage
} from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import {
    authorizeGroupMutation,
    captureAppInboxGroupMutationIngress,
    mutationDescriptor
} from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { toAuthenticatedGroupMutationQueueKey } from '@shared-server/rallar-system/group-state/inbox/to-authenticated-group-mutation-queue-key.ts';
import { decodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { readPersistedCommandEvidence } from '@shared-test/black-box-runner/state-write-evidence/api-v1-state-write-receipt-evidence.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';

import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../shared-server/rallar-system/app-inbox/test-support/test-app-inbox-finished-retention.ts';

const NOW_EPOCH_MS = 1_800_000_000_000;
const SCOPE = { applicationId: 'evidence-app', workspaceId: 'evidence-workspace' };
/** Longer than the queue writer's 36-character resource bound, as the black-box recipes' request ids are. */
const REQUEST_ID = 'api-v1-idempotency-contract-join-request-0001';

describe('state-write persisted command evidence', () => {
    it('finds a queued group join under the key its reservation stored it with', async () => {
        const enqueue = await createQueuedJoin();
        const key = toAuthenticatedGroupMutationQueueKey(enqueue);
        const entry = createAppInboxResourceEntry(enqueue, 'evidence-service', {
            creationNow: () => Temporal.Instant.fromEpochMilliseconds(NOW_EPOCH_MS),
            createMessage: createDefaultAppInboxQueueMessage
        });

        expect(REQUEST_ID.length).toBeGreaterThan(36);
        expect(entry.key).toEqual(key);
        expect(toAppQueueKey(key).resourceId).not.toBe(key.resourceId);
        const evidence = await readPersistedCommandEvidence(createUnreadSql(), {
            ri_resource_id: entry.key.resourceId,
            ri_topic_id: entry.key.topicId,
            fk_ext_bank_id: entry.key.contextId,
            ri_resource: entry.resource,
            result_status: null
        });

        expect(evidence.failure).toBeUndefined();
        expect(evidence).toMatchObject({ valid: true, commandType: AppInboxType.GROUP_JOIN, appInboxResourceId: REQUEST_ID });
    });
});

async function createQueuedJoin(): Promise<AppInboxEnqueueInput> {
    const dependencies = {
        authSessions: { findBySessionId: async () => undefined },
        now: () => NOW_EPOCH_MS,
        randomId: () => 'evidence-random-id',
        serviceId: 'evidence-service',
        finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS
    };
    const authorized = await authorizeGroupMutation(
        dependencies,
        mutationDescriptor({
            operation: 'joinGroup',
            scope: SCOPE,
            groupId: 'evidence-room',
            request: { requestId: REQUEST_ID }
        }),
        {
            clientId: 'alice',
            sessionId: 'alice-session',
            accessToken: 'alice-token',
            username: 'alice',
            issuedAtEpochMs: NOW_EPOCH_MS - 1_000,
            expiresAtEpochMs: NOW_EPOCH_MS + 60_000
        }
    );
    const ingress = await captureAppInboxGroupMutationIngress(dependencies, authorized.descriptor, authorized.authorityProof);
    return {
        type: AppInboxType.GROUP_JOIN,
        topicId: AppInboxType.GROUP_JOIN,
        resourceId: REQUEST_ID,
        contextId: 'application=evidence-app:workspace=evidence-workspace:group=evidence-room:caller=alice',
        senderId: 'alice',
        traceId: 'trace-state-write-receipt-evidence',
        authority: decodeJsonWireValue(ingress),
        data: { scope: SCOPE, groupId: 'evidence-room', request: { requestId: REQUEST_ID } }
    };
}

/** A row that is not yet completed needs no receipt, so the evidence reads nothing back. */
function createUnreadSql() {
    return async () => {
        throw new Error('A queued command needs no runtime-state read');
    };
}

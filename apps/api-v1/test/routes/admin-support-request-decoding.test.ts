import assert from 'node:assert/strict';

import {
    decodeAdminSupportExplainClientRequest,
    decodeAdminSupportExplainCrdtDocumentRequest,
    decodeAdminSupportExplainGroupRequest,
    decodeAdminSupportExplainQueueItemRequest,
    decodeAdminSupportExplainRequestRequest
} from '../../src/routes/admin-support-request-decoding.ts';

const SCOPE = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
};
const GROUP_REF = {
    ...SCOPE,
    groupId: 'room-1'
};
const QUEUE_KEY = {
    topicId: 'group-state.event',
    resourceId: 'request-1',
    contextId: 'room-1'
};

Deno.test('admin support request decoders return complete current request contracts', () => {
    assert.deepEqual(
        decodeAdminSupportExplainClientRequest({
            scope: SCOPE,
            principalId: 'player-1',
            clientInstanceId: 'browser-1',
            sessionId: 'session-1',
            limitRecentEvents: 10
        }),
        {
            scope: SCOPE,
            principalId: 'player-1',
            clientInstanceId: 'browser-1',
            sessionId: 'session-1',
            limitRecentEvents: 10
        }
    );
    assert.deepEqual(
        decodeAdminSupportExplainGroupRequest({
            groupRef: GROUP_REF,
            principalId: 'player-1',
            sessionId: 'session-1',
            limitRecentEvents: 20
        }),
        {
            groupRef: GROUP_REF,
            principalId: 'player-1',
            sessionId: 'session-1',
            limitRecentEvents: 20
        }
    );
    assert.deepEqual(
        decodeAdminSupportExplainRequestRequest({
            requestId: 'request-1',
            idempotencyKey: 'idempotency-1',
            queueKey: QUEUE_KEY,
            target: { kind: 'group', groupRef: GROUP_REF }
        }),
        {
            requestId: 'request-1',
            idempotencyKey: 'idempotency-1',
            queueKey: QUEUE_KEY,
            target: { kind: 'group', groupRef: GROUP_REF }
        }
    );
    assert.deepEqual(
        decodeAdminSupportExplainCrdtDocumentRequest({
            document: {
                ...SCOPE,
                scope: 'app',
                documentType: 'map',
                documentId: 'document-1'
            },
            includeIntegrity: true,
            includeRedactedDebugBundle: false
        }),
        {
            document: {
                ...SCOPE,
                scope: 'app',
                documentType: 'map',
                documentId: 'document-1'
            },
            includeIntegrity: true,
            includeRedactedDebugBundle: false
        }
    );
    assert.deepEqual(
        decodeAdminSupportExplainQueueItemRequest({
            queueKey: QUEUE_KEY,
            includeExpired: true
        }),
        {
            queueKey: QUEUE_KEY,
            includeExpired: true
        }
    );
});

Deno.test('admin support request decoders reject fields outside the current contract', () => {
    assert.throws(
        () =>
            decodeAdminSupportExplainGroupRequest({
                groupRef: GROUP_REF,
                unsupportedField: 'value'
            }),
        /unexpected field unsupportedField/
    );
});

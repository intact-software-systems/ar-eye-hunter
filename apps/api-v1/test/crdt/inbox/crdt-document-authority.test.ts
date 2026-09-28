import assert from 'node:assert/strict';

import type { RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';

import { createApiCrdtDocumentAccessAuthorizer, createApiCrdtDocumentAuthorizer } from '../../../src/crdt/create-api-crdt-document-authorizer.ts';
import { appendCommand } from '../crdt-api-test-fixtures.ts';

const NOW = 10_000;
const ROOM_DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'document-1',
    roomRef: {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1'
    }
};

Deno.test(
    'document authorizer rejects an audience mismatch before state and clock reads',
    async () => {
        const events: string[] = [];
        const authorize = createApiCrdtDocumentAuthorizer({
            readGroupSnapshot: () => {
                events.push('group');
                return Promise.resolve(undefined);
            },
            readClientSnapshot: () => {
                events.push('client');
                return Promise.resolve(undefined);
            },
            nowEpochMs: () => {
                events.push('clock');
                return NOW;
            }
        });

        const command = await appendCommand({
            now: NOW,
            commandId: 'audience-command',
            updateId: 'audience-update',
            actor: {
                actorId: 'client-1',
                principalId: 'alice',
                sessionId: 'session-1',
                serverId: 'server-1'
            }
        });
        const result = await authorize(
            {
                ...command,
                responseAudience: {
                    kind: 'room',
                    senderSessionId: 'session-1',
                    topicId: 'room.crdt',
                    contextId: 'another-group'
                }
            },
            {
                clientId: 'client-1',
                username: 'alice',
                sessionId: 'session-1',
                expiresAtEpochMs: NOW + 1_000
            }
        );

        assert.deepEqual(result, { allowed: false, code: 'authorization-scope-denied', publicationAuthority: null });
        assert.deepEqual(events, []);
    }
);

Deno.test('room authority reads membership before one current-session expiry clock', async () => {
    const events: string[] = [];
    const authorizeDocumentAccess = createApiCrdtDocumentAccessAuthorizer({
        readGroupSnapshot: () => {
            events.push('group');
            return Promise.resolve({
                group: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
                members: [{ principalId: 'alice', status: 'active' }],
                activeSessions: [
                    {
                        principalId: 'alice',
                        sessionId: 'old-session',
                        status: 'active',
                        expiresAtEpochMs: NOW + 1_000
                    },
                    {
                        principalId: 'alice',
                        sessionId: 'session-1',
                        status: 'active',
                        expiresAtEpochMs: NOW + 1_000
                    }
                ]
            });
        },
        readClientSnapshot: () => Promise.resolve(undefined),
        nowEpochMs: () => {
            events.push('clock');
            return NOW;
        }
    });
    const result = await authorizeDocumentAccess({
        document: ROOM_DOCUMENT,
        actorPrincipalId: 'alice',
        sessionId: 'session-1'
    });

    assert.deepEqual(result, {
        allowed: true,
        code: 'allowed',
        publicationAuthority: {
            recipientScope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            admittedAudience: ['old-session', 'session-1']
        }
    });
    assert.deepEqual(events, ['group', 'clock']);
});

Deno.test('principal authority reads current client before one session expiry clock', async () => {
    const events: string[] = [];
    const authorizeDocumentAccess = createApiCrdtDocumentAccessAuthorizer({
        readGroupSnapshot: () => Promise.resolve(undefined),
        readClientSnapshot: () => {
            events.push('client');
            return Promise.resolve({
                principal: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    principalId: 'alice',
                    status: 'active'
                },
                activeSessions: [
                    {
                        sessionId: 'old-session',
                        status: 'active',
                        expiresAtEpochMs: NOW + 1_000
                    },
                    {
                        sessionId: 'session-1',
                        status: 'active',
                        expiresAtEpochMs: NOW + 1_000
                    }
                ]
            });
        },
        nowEpochMs: () => {
            events.push('clock');
            return NOW;
        }
    });
    const result = await authorizeDocumentAccess({
        document: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            scope: 'principal',
            documentType: 'checklist',
            documentId: 'document-2',
            principalId: 'alice'
        },
        actorPrincipalId: 'alice',
        sessionId: 'session-1'
    });

    assert.deepEqual(result, {
        allowed: true,
        code: 'allowed',
        publicationAuthority: {
            recipientScope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            admittedAudience: ['old-session', 'session-1']
        }
    });
    assert.deepEqual(events, ['client', 'clock']);
});

Deno.test('CRDT room authority refuses a snapshot returned from another workspace', async () => {
    const authorizeDocumentAccess = createApiCrdtDocumentAccessAuthorizer({
        readGroupSnapshot: () =>
            Promise.resolve({
                group: { applicationId: 'app-1', workspaceId: 'other-workspace', groupId: 'group-1' },
                members: [{ principalId: 'alice', status: 'active' }],
                activeSessions: [{
                    principalId: 'alice',
                    sessionId: 'session-1',
                    status: 'active',
                    expiresAtEpochMs: NOW + 1_000
                }]
            }),
        readClientSnapshot: () => Promise.resolve(undefined),
        nowEpochMs: () => NOW
    });

    assert.deepEqual(
        await authorizeDocumentAccess({
            document: ROOM_DOCUMENT,
            actorPrincipalId: 'alice',
            sessionId: 'session-1'
        }),
        { allowed: false, code: 'authorization-scope-denied', publicationAuthority: null }
    );
});

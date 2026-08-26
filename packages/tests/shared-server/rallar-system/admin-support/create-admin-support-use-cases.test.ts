import type {
    AdminSupportQueueEntryRead,
    AdminSupportUseCaseDependencies,
    AdminSupportUseCases
} from '@shared-server/rallar-system/admin-support/admin-support-contracts.ts';
import { createAdminSupportUseCases } from '@shared-server/rallar-system/admin-support/create-admin-support-use-cases.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { AdminSupportExplainRequestRequest } from '@shared/api/admin-support/admin-support-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupTopologyManagementView } from '@shared/api/graph-topology-management-types.ts';
import type { AuditStamp, GroupEvent, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarCrdtDocumentMetadata, RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { createTestGroup } from '../../../create-test-group.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;
const SCOPE = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
};
const QUEUE_KEY: Key = {
    topicId: 'group-state.event',
    resourceId: 'request-1',
    contextId: 'room-1'
};

type AdminSupportTestCall = readonly (string | number | boolean | object | null | undefined)[];

describe('admin support use cases', () => {
    it('explains queue items with redacted payload metadata from inbox and result rows', async () => {
        const timingEvents: RallarTimingEvent[] = [];
        const reader = new FakeSupportReader({
            queueEntry: {
                source: 'resource_inbox',
                key: QUEUE_KEY,
                typeId: 'WS_OUTBOX',
                status: 'RETRY',
                attempts: 2,
                createdAtEpochMs: NOW_EPOCH_MS - 5_000,
                expiresAtEpochMs: NOW_EPOCH_MS + 55_000,
                nextRetryAtEpochMs: NOW_EPOCH_MS + 1_000,
                payload: JSON.stringify({
                    secret: 'do-not-return',
                    kind: 'group-state.event'
                })
            },
            resultEntry: {
                source: 'resource_inbox_results',
                key: QUEUE_KEY,
                typeId: 'APP_INBOX',
                status: 'FAILED',
                attempts: 0,
                createdAtEpochMs: NOW_EPOCH_MS - 4_000,
                expiresAtEpochMs: NOW_EPOCH_MS + 56_000,
                payload: JSON.stringify({
                    accessToken: 'never-return',
                    ok: false
                })
            }
        });
        const service = createService({
            reader,
            timing: (event) => timingEvents.push(event)
        });

        const result = await service.explainQueueItem({
            adminSession: createAdminSession(),
            request: {
                queueKey: QUEUE_KEY,
                includeExpired: true
            }
        });

        expect(reader.calls).toEqual([
            ['readQueueEntry', QUEUE_KEY, true],
            ['readQueueResult', QUEUE_KEY, true]
        ]);
        expect(result).toMatchObject({
            generatedAtEpochMs: NOW_EPOCH_MS,
            serverId: 'test-server',
            target: {
                kind: 'queue-item',
                queueKey: QUEUE_KEY
            },
            facts: expect.arrayContaining([
                {
                    label: 'inbox.status',
                    source: 'resource_inbox',
                    value: 'RETRY',
                    certainty: 'exact'
                },
                {
                    label: 'result.status',
                    source: 'resource_inbox_results',
                    value: 'FAILED',
                    certainty: 'exact'
                }
            ]),
            warnings: [],
            likelyCauses: expect.arrayContaining(['Queue item is waiting for retry.'])
        });
        expect(JSON.stringify(result)).not.toContain('do-not-return');
        expect(JSON.stringify(result)).not.toContain('never-return');
        expect(result.facts).toContainEqual({
            label: 'inbox.payload',
            source: 'resource_inbox',
            value: {
                byteLength: 53,
                jsonKind: 'object',
                topLevelKeys: ['kind', 'secret']
            },
            certainty: 'exact',
            redacted: true
        });
        expect(timingEvents).toHaveLength(1);
        expect(timingEvents[0]).toMatchObject({
            operation: 'explain.queue-item',
            principalId: 'platform-admin',
            sessionId: 'admin-session',
            details: {
                adminClientId: 'platform-admin',
                queueTopicId: QUEUE_KEY.topicId,
                queueResourceId: QUEUE_KEY.resourceId,
                queueContextId: QUEUE_KEY.contextId,
                warningCount: 0,
                factCount: result.facts.length
            }
        });
    });

    it('refuses unscoped global request id search and records support timing', async () => {
        const events: RallarTimingEvent[] = [];
        const reader = new FakeSupportReader();
        const service = createService({
            reader,
            timing: (event) => events.push(event)
        });
        const request: AdminSupportExplainRequestRequest = {
            requestId: 'request-1'
        };

        const result = await service.explainRequest({
            adminSession: createAdminSession(),
            request
        });

        expect(reader.calls).toEqual([]);
        expect(result.warnings).toContainEqual({
            code: 'unsupported-global-request-search',
            message: 'Request explanation requires queueKey or a specific target in phase 1.',
            source: 'admin-support'
        });
        expect(result.facts).toContainEqual({
            label: 'request.search',
            source: 'admin-support',
            value: 'not-run',
            certainty: 'unavailable'
        });
        expect(events[0]).toMatchObject({
            type: 'rallar.timing',
            component: 'admin-support',
            operation: 'explain.request',
            status: 'ok',
            serviceId: 'test-server',
            requestId: 'request-1',
            principalId: 'platform-admin',
            sessionId: 'admin-session'
        });
        expect(JSON.stringify(events[0])).not.toContain('access-token');
    });

    it('reports unavailable client state without claiming live websocket status', async () => {
        const service = createService();

        const result = await service.explainClient({
            adminSession: createAdminSession(),
            request: {
                scope: SCOPE,
                principalId: 'missing-player'
            }
        });

        expect(result.facts).toContainEqual({
            label: 'client.snapshot',
            source: 'client-state',
            value: 'missing',
            certainty: 'unavailable'
        });
        expect(result.warnings).toContainEqual({
            code: 'client-readers-unconfigured',
            message: 'Client state readers are not configured for support explanation.',
            source: 'admin-support'
        });
        expect(result.warnings.some((warning) => warning.code === 'process-local-realtime'))
            .toBe(false);
    });

    it('explains client state, bounded events, and process-local websocket matches', async () => {
        const calls: AdminSupportTestCall[] = [];
        const clientSnapshot = createClientSnapshot();
        const recentEvents: ClientEvent[] = [{
            ...SCOPE,
            principalId: 'player-1',
            eventId: 'client-event-1',
            eventType: 'session-connected',
            snapshotVersion: 4,
            clientInstanceId: 'device-1',
            sessionId: 'client-session-1',
            occurredAtEpochMs: NOW_EPOCH_MS - 4_000,
            actor: {
                kind: 'session',
                principalId: 'player-1',
                sessionId: 'client-session-1'
            },
            reason: null,
            traceId: null,
            requestId: null,
            payload: { token: 'timeline-secret' }
        }];
        const service = createService({
            clientStateService: {
                readSnapshot: async (ref) => {
                    calls.push(['readClientSnapshot', ref]);
                    return clientSnapshot;
                },
                readPresenceSnapshot: async (ref) => {
                    calls.push(['readClientPresenceSnapshot', ref]);
                    return {
                        ...SCOPE,
                        principalId: 'player-1',
                        presenceVersion: 3,
                        isOnline: true,
                        presenceState: 'online',
                        activeSessions: clientSnapshot.activeSessions,
                        lastSeenAtEpochMs: NOW_EPOCH_MS - 500
                    };
                },
                listRecentEvents: async (ref, query) => {
                    calls.push(['listRecentClientEvents', ref, query]);
                    return recentEvents;
                }
            },
            wsStatus: () => ({
                transport: 'ws-server',
                connectionCount: 2,
                openConnectionCount: 1,
                connectionIds: ['connection-1', 'connection-closed'],
                openConnectionIds: ['connection-1'],
                connections: [
                    { connectionId: 'connection-1', isOpen: true },
                    { connectionId: 'connection-closed', isOpen: false }
                ]
            })
        });

        const result = await service.explainClient({
            adminSession: createAdminSession(),
            request: {
                scope: SCOPE,
                principalId: 'player-1',
                clientInstanceId: 'device-1',
                sessionId: 'client-session-1',
                limitRecentEvents: 3
            }
        });

        expect(calls).toEqual([
            ['readClientSnapshot', { ...SCOPE, principalId: 'player-1' }],
            ['readClientPresenceSnapshot', { ...SCOPE, principalId: 'player-1' }],
            ['listRecentClientEvents', { ...SCOPE, principalId: 'player-1' }, { limit: 3 }]
        ]);
        expect(result.facts).toEqual(expect.arrayContaining([
            {
                label: 'client.snapshot',
                source: 'client-state',
                value: 'found',
                certainty: 'exact'
            },
            {
                label: 'client.activeSessionCount',
                source: 'client-state',
                value: 1,
                certainty: 'exact'
            },
            {
                label: 'client.session.status',
                source: 'client-state',
                value: 'active',
                certainty: 'exact'
            },
            {
                label: 'client.session.currentProcessOpen',
                source: 'websocket',
                value: true,
                certainty: 'exact'
            },
            {
                label: 'client.recentEventCount',
                source: 'client-state-events',
                value: 1,
                certainty: 'exact'
            }
        ]));
        expect(result.timeline).toContainEqual({
            atEpochMs: NOW_EPOCH_MS - 4_000,
            source: 'client-state-events',
            eventType: 'session-connected',
            summary: 'Client event session-connected.',
            rawRef: 'client-event:client-event-1'
        });
        expect(result.warnings).toContainEqual({
            code: 'process-local-realtime',
            message: 'WebSocket connection status is process-local and may not include other API workers.',
            source: 'websocket'
        });
        expect(result.rawRefs).toContain('client:app-1/workspace-1/player-1');
        expect(JSON.stringify(result)).not.toContain('timeline-secret');
    });

    it('explains group snapshots, topology views, and bounded group events', async () => {
        const calls: AdminSupportTestCall[] = [];
        const groupRef: GroupRef = {
            ...SCOPE,
            groupId: 'room-1'
        };
        const groupSnapshot = createGroupSnapshot(groupRef);
        const recentEvents: GroupEvent[] = [{
            ...groupRef,
            eventId: 'group-event-1',
            eventType: 'session-connected',
            snapshotVersion: 7,
            causalRevision: { groupRevision: 7, presenceRevision: 3 },
            occurredAtEpochMs: NOW_EPOCH_MS - 6_000,
            actor: {
                kind: 'session',
                principalId: 'player-1',
                sessionId: 'group-session-1'
            },
            reason: null,
            traceId: null,
            requestId: null,
            payload: { accessToken: 'group-secret' }
        }];
        const effectiveTopologyConfig = {
            topologyKind: 'mesh' as const,
            degreeLimit: 4,
            treeMinSize: 4,
            meshMinSize: 2,
            meshParamK: 2
        };
        const topologyView: GroupTopologyManagementView = {
            groupRef,
            overlayId: 'overlay-1',
            config: {
                serverDefaults: effectiveTopologyConfig,
                durable: null,
                temporary: null,
                requestOptions: null,
                effective: effectiveTopologyConfig
            },
            snapshot: {
                sourceGroupStateCausalRevision: {
                    groupRevision: 7,
                    presenceRevision: 3
                },
                state: 'active',
                overlayId: 'overlay-1',
                groupRef,
                name: 'mesh room',
                topology: 'mesh',
                activeSessionIds: ['group-session-1', 'group-session-2'],
                nextHopsBySessionId: {
                    'group-session-1': ['group-session-2'],
                    'group-session-2': ['group-session-1']
                },
                degreeLimit: 4,
                version: 1,
                createdByClientId: 'test-server',
                createdAtEpochMs: NOW_EPOCH_MS - 2_000,
                updatedAtEpochMs: NOW_EPOCH_MS - 1_000
            },
            pending: null
        };
        const service = createService({
            groupStateService: {
                readSnapshot: async (ref) => {
                    calls.push(['readGroupSnapshot', ref]);
                    return groupSnapshot;
                },
                listRecentEvents: async (ref, query) => {
                    calls.push(['listRecentGroupEvents', ref, query]);
                    return recentEvents;
                }
            },
            topologyQuery: {
                readTopologyView: async (ref) => {
                    calls.push(['readTopologyView', ref]);
                    return topologyView;
                }
            }
        });

        const result = await service.explainGroup({
            adminSession: createAdminSession(),
            request: {
                groupRef,
                principalId: 'player-1',
                sessionId: 'group-session-1',
                limitRecentEvents: 2
            }
        });

        expect(calls).toEqual([
            ['readGroupSnapshot', groupRef],
            ['listRecentGroupEvents', groupRef, { limit: 2 }],
            ['readTopologyView', groupRef]
        ]);
        expect(result.facts).toEqual(expect.arrayContaining([
            {
                label: 'group.snapshot',
                source: 'group-state',
                value: 'found',
                certainty: 'exact'
            },
            {
                label: 'group.status',
                source: 'group-state',
                value: 'active',
                certainty: 'exact'
            },
            {
                label: 'group.onlineMemberCount',
                source: 'group-state',
                value: 1,
                certainty: 'exact'
            },
            {
                label: 'group.session.match',
                source: 'group-state',
                value: 'found',
                certainty: 'exact'
            },
            {
                label: 'group.topology',
                source: 'group-topology',
                value: {
                    present: true,
                    topologyKind: 'mesh',
                    participantCount: 2
                },
                certainty: 'exact'
            }
        ]));
        expect(result.timeline).toContainEqual({
            atEpochMs: NOW_EPOCH_MS - 6_000,
            source: 'group-state-events',
            eventType: 'session-connected',
            summary: 'Group event session-connected.',
            rawRef: 'group-event:group-event-1'
        });
        expect(result.warnings).toEqual([]);
        expect(result.rawRefs).toContain('group:app-1/workspace-1/room-1');
        expect(JSON.stringify(result)).not.toContain('group-secret');
    });

    it('explains group snapshots with a clear warning when topology is unavailable', async () => {
        const groupRef: GroupRef = {
            ...SCOPE,
            groupId: 'room-1'
        };
        const service = createService({
            groupStateService: {
                readSnapshot: () => Promise.resolve(createGroupSnapshot(groupRef)),
                listRecentEvents: () => Promise.resolve([])
            }
        });

        const result = await service.explainGroup({
            adminSession: createAdminSession(),
            request: {
                groupRef
            }
        });

        expect(result.facts).toContainEqual({
            label: 'group.topology',
            source: 'group-topology',
            value: { present: false },
            certainty: 'unavailable'
        });
        expect(result.warnings).toContainEqual({
            code: 'topology-reader-unconfigured',
            message: 'Group topology reader is not configured for support explanation.',
            source: 'group-topology'
        });
    });

    it('explains CRDT document metadata, integrity, and redacted debug export summaries', async () => {
        const calls: AdminSupportTestCall[] = [];
        const document: RallarCrdtDocumentRef = {
            ...SCOPE,
            scope: 'room',
            documentType: 'map',
            documentId: 'doc-1',
            roomRef: {
                ...SCOPE,
                groupId: 'room-1'
            }
        };
        const metadata: RallarCrdtDocumentMetadata = {
            document,
            documentKey: 'crdt:map:doc-1',
            documentRevision: 4,
            lifecycle: 'active',
            createdAtEpochMs: NOW_EPOCH_MS - 10_000,
            updatedAtEpochMs: NOW_EPOCH_MS - 1_000,
            archivedAtEpochMs: null,
            destroyedAtEpochMs: null,
            lastAppendSequence: 4,
            updateCount: 4,
            snapshotCount: 1,
            storedUpdateBytes: 2_048,
            retention: null,
            quota: null,
            projectionIds: ['summary']
        };
        const service = createService({
            crdtAdminRepository: {
                readDocumentMetadata: async (ref: RallarCrdtDocumentRef) => {
                    calls.push(['readDocumentMetadata', ref]);
                    return metadata;
                },
                verifyIntegrity: async (ref) => {
                    calls.push(['verifyIntegrity', ref]);
                    return {
                        valid: false,
                        issues: [{
                            path: 'records[2]',
                            code: 'sequence-gap',
                            message: 'Missing append sequence.'
                        }],
                        documentKey: 'crdt:map:doc-1',
                        checkedUpdateCount: 4,
                        sequenceGaps: [3],
                        bundleHash: 'bundle-hash'
                    };
                },
                exportDebugBundle: async (ref, options) => {
                    calls.push(['exportDebugBundle', ref, options]);
                    return {
                        format: 'rallar.crdt.debug-bundle.v1',
                        exportedAtEpochMs: NOW_EPOCH_MS,
                        reason: 'api-v1-admin-support-debug-export',
                        document: ref,
                        documentKey: 'crdt:map:doc-1',
                        metadata,
                        records: [{
                            document: ref,
                            documentKey: 'crdt:map:doc-1',
                            update: {
                                protocolVersion: 1,
                                updateId: 'update-1',
                                document: ref,
                                replicaId: 'replica-1',
                                lamport: 1,
                                parents: [],
                                schemaVersion: 1,
                                operationVersion: 1,
                                createdAtEpochMs: NOW_EPOCH_MS - 2_000,
                                payload: {
                                    kind: 'batch',
                                    operations: [{
                                        kind: 'register.set',
                                        path: ['token'],
                                        value: 'raw-crdt-secret',
                                        policy: 'lww'
                                    }]
                                }
                            },
                            append: {
                                appendSequence: 1,
                                acceptedAtEpochMs: NOW_EPOCH_MS - 2_000,
                                actorId: 'client-1',
                                principalId: 'player-1',
                                sessionId: 'session-1',
                                serverId: 'test-server',
                                authorizationScope: 'room',
                                acceptedUpdateHash: 'hash-1'
                            }
                        }],
                        redaction: {
                            payloadsRedacted: true,
                            reason: 'api-v1-admin-support-redaction'
                        },
                        integrity: {
                            bundleHash: 'bundle-hash',
                            documentRefHash: 'doc-hash',
                            updateHashes: { '1': 'hash-1' },
                            firstAppendSequence: 1,
                            lastAppendSequence: 1,
                            updateCount: 1,
                            sequenceGaps: []
                        }
                    };
                }
            }
        });

        const result = await service.explainCrdtDocument({
            adminSession: createAdminSession(),
            request: {
                document,
                includeIntegrity: true,
                includeRedactedDebugBundle: true
            }
        });

        expect(calls[0]).toEqual(['readDocumentMetadata', document]);
        expect(calls[1]).toEqual(['verifyIntegrity', document]);
        expect(calls[2]).toEqual([
            'exportDebugBundle',
            document,
            {
                reason: 'api-v1-admin-support-debug-export',
                exportedAtEpochMs: NOW_EPOCH_MS,
                redaction: {
                    payloadsRedacted: true,
                    reason: 'api-v1-admin-support-redaction'
                }
            }
        ]);
        expect(result.facts).toEqual(expect.arrayContaining([
            {
                label: 'crdt.metadata',
                source: 'crdt-admin-log',
                value: 'found',
                certainty: 'exact'
            },
            {
                label: 'crdt.lifecycle',
                source: 'crdt-admin-log',
                value: 'active',
                certainty: 'exact'
            },
            {
                label: 'crdt.updateCount',
                source: 'crdt-admin-log',
                value: 4,
                certainty: 'exact'
            },
            {
                label: 'crdt.integrity.valid',
                source: 'crdt-admin-log',
                value: false,
                certainty: 'exact'
            },
            {
                label: 'crdt.debugExport',
                source: 'crdt-admin-log',
                value: {
                    format: 'rallar.crdt.debug-bundle.v1',
                    recordCount: 1,
                    payloadsRedacted: true,
                    updateCount: 1
                },
                certainty: 'exact',
                redacted: true
            }
        ]));
        expect(result.warnings).toContainEqual({
            code: 'crdt-integrity-invalid',
            message: 'CRDT integrity verification reported validation issues.',
            source: 'crdt-admin-log'
        });
        expect(result.rawRefs).toContain('crdt:crdt:map:doc-1');
        expect(JSON.stringify(result)).not.toContain('raw-crdt-secret');
    });

    it('explains result-only queue items as partial data without returning payloads', async () => {
        const reader = new FakeSupportReader({
            resultEntry: {
                source: 'resource_inbox_results',
                key: QUEUE_KEY,
                typeId: 'APP_INBOX',
                status: 'COMPLETED',
                attempts: 0,
                createdAtEpochMs: NOW_EPOCH_MS - 4_000,
                expiresAtEpochMs: NOW_EPOCH_MS + 56_000,
                payload: JSON.stringify({
                    secretResult: 'do-not-return-result-only',
                    ok: true
                })
            }
        });
        const service = createService({ reader });

        const result = await service.explainQueueItem({
            adminSession: createAdminSession(),
            request: {
                queueKey: QUEUE_KEY,
                includeExpired: true
            }
        });

        expect(result.facts).toContainEqual({
            label: 'result.status',
            source: 'resource_inbox_results',
            value: 'COMPLETED',
            certainty: 'exact'
        });
        expect(result.warnings).toContainEqual({
            code: 'queue-inbox-row-missing',
            message: 'No matching resource_inbox row was found for the QueueBox key.',
            source: 'resource_inbox'
        });
        expect(result.likelyCauses).toContain(
            'Queue inbox row is missing but a durable result exists.'
        );
        expect(JSON.stringify(result)).not.toContain('do-not-return-result-only');
    });
});

type FakeSupportReaderOptions = Readonly<{
    queueEntry?: AdminSupportQueueEntryRead;
    resultEntry?: AdminSupportQueueEntryRead;
}>;

class FakeSupportReader {
    readonly calls: AdminSupportTestCall[] = [];

    private readonly options: FakeSupportReaderOptions;

    constructor(options: FakeSupportReaderOptions = {}) {
        this.options = options;
    }

    async readQueueEntry(
        key: Key,
        includeExpired: boolean
    ): Promise<AdminSupportQueueEntryRead | undefined> {
        this.calls.push(['readQueueEntry', key, includeExpired]);
        return this.options.queueEntry;
    }

    async readQueueResult(
        key: Key,
        includeExpired: boolean
    ): Promise<AdminSupportQueueEntryRead | undefined> {
        this.calls.push(['readQueueResult', key, includeExpired]);
        return this.options.resultEntry;
    }
}

function createService(
    overrides: Partial<AdminSupportUseCaseDependencies> = {}
): AdminSupportUseCases {
    return createAdminSupportUseCases({
        now: () => NOW_EPOCH_MS,
        serverId: 'test-server',
        reader: new FakeSupportReader(),
        ...overrides
    });
}

function createAdminSession(): AuthSession {
    return {
        clientId: 'platform-admin',
        username: 'admin',
        accessToken: 'access-token',
        sessionId: 'admin-session',
        expiresAtEpochMs: NOW_EPOCH_MS + 60_000
    };
}

function createClientSnapshot(): ClientSnapshot {
    const created = createAuditStamp(NOW_EPOCH_MS - 30_000);
    const updated = createAuditStamp(NOW_EPOCH_MS - 2_000);
    return {
        stateRevision: 4,
        principal: {
            ...SCOPE,
            principalId: 'player-1',
            username: 'player-1',
            displayName: 'Player 1',
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            disabled: null,
            deleted: null,
            roles: ['player'],
            metadata: {},
            snapshotVersion: 4,
            profileVersion: 1,
            presenceVersion: 3,
            created,
            updated,
            lastSeenAtEpochMs: NOW_EPOCH_MS - 500
        },
        instances: [{
            ...SCOPE,
            principalId: 'player-1',
            clientInstanceId: 'device-1',
            status: 'active',
            revoked: null,
            platform: 'web',
            deviceLabel: 'Browser',
            appVersion: null,
            userAgent: null,
            capabilities: ['ws'],
            registered: createAuditStamp(NOW_EPOCH_MS - 20_000),
            updated
        }],
        activeSessions: [{
            ...SCOPE,
            principalId: 'player-1',
            clientInstanceId: 'device-1',
            sessionId: 'client-session-1',
            generationId: 'client-session-generation-1',
            generationVersion: 1,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null,
            presenceState: 'online',
            transport: 'ws',
            connectionId: 'connection-1',
            authenticatedAtEpochMs: NOW_EPOCH_MS - 10_000,
            connectedAtEpochMs: NOW_EPOCH_MS - 9_000,
            lastHeartbeatAtEpochMs: NOW_EPOCH_MS - 500,
            expiresAtEpochMs: NOW_EPOCH_MS + 60_000
        }],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: NOW_EPOCH_MS - 500
    };
}

function createGroupSnapshot(groupRef: GroupRef): GroupSnapshot {
    const created = createAuditStamp(NOW_EPOCH_MS - 30_000);
    const updated = createAuditStamp(NOW_EPOCH_MS - 2_000);
    return {
        causalRevision: { groupRevision: 7, presenceRevision: 3 },
        group: createTestGroup({
            ...groupRef,
            displayName: 'Room 1',
            activeMemberCount: 1,
            ownerPrincipalId: 'player-1',
            snapshotVersion: 7,
            metadataVersion: 1,
            rosterVersion: 2,
            presenceVersion: 3,
            created,
            updated
        }),
        members: [{
            ...groupRef,
            principalId: 'player-1',
            role: 'member',
            status: 'active',
            joined: createAuditStamp(NOW_EPOCH_MS - 20_000),
            updated,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null
        }],
        activeSessions: [{
            ...groupRef,
            principalId: 'player-1',
            sessionId: 'group-session-1',
            generationId: 'group-session-generation-1',
            generationVersion: 1,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null,
            connectedAtEpochMs: NOW_EPOCH_MS - 9_000,
            lastHeartbeatAtEpochMs: NOW_EPOCH_MS - 500,
            expiresAtEpochMs: NOW_EPOCH_MS + 60_000
        }],
        memberCount: 1,
        onlineMemberCount: 1
    };
}

function createAuditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}

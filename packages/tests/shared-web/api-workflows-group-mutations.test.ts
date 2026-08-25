import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { appointStateGroupDirector } from '@shared-web/browser/director/appoint-room-director.ts';
import {
    archiveStateGroup,
    deleteStateGroup,
    updateStateGroupDetails,
    updateStateGroupMetadata
} from '@shared-web/browser/rooms/room-group-state-mutation-workflows.ts';
import { createAndJoinStateGroup, joinStateGroup, leaveStateGroup } from '@shared-web/browser/rooms/room-group-state-workflows.ts';
import {
    acceptStateGroupInvite,
    banStateGroupMember,
    createStateGroupInvite,
    removeStateGroupMember,
    revokeStateGroupInvite,
    rotateStateGroupJoinCode,
    setStateGroupMemberRole,
    transferStateGroupOwnership,
    unbanStateGroupMember
} from '@shared-web/browser/rooms/room-membership-group-state-workflows.ts';
import {
    deleteStateGroupTopologyConfig,
    deleteStateGroupTopologyOverride,
    putStateGroupTopologyConfig,
    putStateGroupTopologyOverride,
    reconfigureStateGroupTopology
} from '@shared-web/browser/rtc/rtc-topology-http-api.ts';
import type {
    GroupTopologyConfigAcceptedCausalRevision,
    PutGroupTopologyConfigRequest,
    PutGroupTopologyOverrideRequest,
    ReconfigureGroupTopologyRequest
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

type FetchCall = Readonly<{
    url: string;
    physicalUrl: string;
    method: string;
    headers: Record<string, string>;
    body?: object;
    signal?: AbortSignal | null;
}>;

describe('state API group and topology mutation workflows', () => {
    const fetchCalls: FetchCall[] = [];

    beforeEach(() => {
        fetchCalls.length = 0;
        configureApiClient({ apiBaseUrl: '' });
        vi.stubGlobal('localStorage', {
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
            removeItem: vi.fn()
        });
    });

    afterEach(() => {
        configureApiClient({ apiBaseUrl: '' });
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('mutates topology config and overrides with auth-capable methods', async () => {
        expectTypeOf<PutGroupTopologyConfigRequest>().toMatchTypeOf<Readonly<{ requestId: string; }>>();
        expectTypeOf<PutGroupTopologyOverrideRequest>().toMatchTypeOf<Readonly<{ requestId: string; }>>();
        expectTypeOf<ReconfigureGroupTopologyRequest>().toMatchTypeOf<Readonly<{ requestId: string; }>>();
        type ConfigReceipt = Awaited<ReturnType<typeof putStateGroupTopologyConfig>>['receipt'];
        expectTypeOf<ConfigReceipt['acceptedCausalRevision']>().toEqualTypeOf<GroupTopologyConfigAcceptedCausalRevision | null>();
        const scope = {
            applicationId: 'app 1',
            workspaceId: 'workspace/1'
        };
        const authSession = {
            clientId: 'owner-1',
            username: 'owner',
            sessionId: 'owner-session',
            accessToken: 'token-1',
            expiresAtEpochMs: Date.now() + 60_000
        };
        stubFetch(() => jsonResponse({ ok: true }));

        await putStateGroupTopologyConfig({
            groupId: 'room /1',
            request: {
                config: { topologyKind: 'mesh', degreeLimit: 3 }
            },
            options: { authSession, requestId: 'topology-config-put-request-1' },
            scope
        });
        await putStateGroupTopologyOverride({
            groupId: 'room /1',
            request: {
                config: { topologyKind: 'star' },
                ttlMs: 60_000
            },
            options: { authSession, requestId: 'topology-override-put-request-1' },
            scope
        });
        await reconfigureStateGroupTopology({
            groupId: 'room /1',
            request: {
                options: { topologyKind: 'tree' },
                publish: false
            },
            options: { authSession, requestId: 'topology-reconfigure-request-1' },
            scope
        });
        await deleteStateGroupTopologyConfig({
            groupId: 'room /1',
            options: {
                authSession,
                requestId: 'topology-config-delete-request-1'
            },
            scope
        });
        await deleteStateGroupTopologyOverride({
            groupId: 'room /1',
            options: {
                authSession,
                requestId: 'topology-override-delete-request-1'
            },
            scope
        });

        const topologyPath = '/api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/topology';
        expect(fetchCalls.map((call) => `${call.method} ${call.physicalUrl}`)).toEqual([
            `PUT ${topologyPath}/config/requests/topology-config-put-request-1`,
            `PUT ${topologyPath}/override/requests/topology-override-put-request-1`,
            `POST ${topologyPath}/reconfigure/requests/topology-reconfigure-request-1`,
            `DELETE ${topologyPath}/config/requests/topology-config-delete-request-1`,
            `DELETE ${topologyPath}/override/requests/topology-override-delete-request-1`
        ]);
        expect(fetchCalls.every((call) => call.headers.authorization === 'Bearer token-1')).toBe(true);
        expect(fetchCalls.every((call) => call.headers['idempotency-key'] === undefined)).toBe(true);
        expect(fetchCalls[0].body).toMatchObject({
            config: { topologyKind: 'mesh', degreeLimit: 3 }
        });
        expect(fetchCalls[1].body).toMatchObject({
            config: { topologyKind: 'star' },
            ttlMs: 60_000
        });
        expect(fetchCalls[2].body).toMatchObject({
            options: { topologyKind: 'tree' },
            publish: false
        });
        expect(fetchCalls.slice(0, 3).every((call) => !hasRequestId(call.body))).toBe(true);
        expect(fetchCalls[3].body).toEqual({});
        expect(fetchCalls[4].body).toEqual({});
    });

    it('rejects empty topology mutation request ids before issuing HTTP', async () => {
        const scope = { applicationId: 'app', workspaceId: 'workspace' };
        const cases = [
            () =>
                putStateGroupTopologyConfig({
                    groupId: 'room',
                    request: { config: {} },
                    options: { requestId: '' },
                    scope
                }),
            () =>
                putStateGroupTopologyOverride({
                    groupId: 'room',
                    request: { config: {}, ttlMs: 1 },
                    options: { requestId: '' },
                    scope
                }),
            () =>
                reconfigureStateGroupTopology({
                    groupId: 'room',
                    request: {},
                    options: { requestId: '' },
                    scope
                }),
            () =>
                deleteStateGroupTopologyConfig({
                    groupId: 'room',
                    options: { requestId: '' },
                    scope
                }),
            () =>
                deleteStateGroupTopologyOverride({
                    groupId: 'room',
                    options: { requestId: '' },
                    scope
                })
        ];

        for (const call of cases) {
            await expect(call()).rejects.toThrow('API mutation requestId must contain');
        }
        expect(fetchCalls).toHaveLength(0);
    });

    it('creates and joins a state group as a sequential workflow', async () => {
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('group-created' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('create-request-00000001' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('presence-request-000001' as ReturnType<typeof crypto.randomUUID>);
        stubFetch(({ url, method, body }) => {
            if (method === 'POST' && url.endsWith('/groups')) {
                const request = body as { groupId: string; };
                return jsonResponse(groupSnapshot(request.groupId));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-created/sessions/session-1')) {
                return jsonResponse(groupSnapshot('group-created'));
            }

            return notFoundResponse();
        });

        const result = await createAndJoinStateGroup({
            displayName: 'My Room',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1'
        });

        expect(result.group.groupId).toBe('group-created');
        expect(fetchCalls.map((call) => call.method)).toEqual(['POST', 'PUT']);
        expect(fetchCalls[0].body).toMatchObject({
            groupId: 'group-created',
            slug: 'my-room',
            displayName: 'My Room',
            createdByPrincipalId: 'principal-1'
        });
        expect(fetchCalls[1].body).toMatchObject({
            generationId: 'generation-1'
        });
    });

    it('creates and joins a state group with an explicit group id', async () => {
        stubFetch(({ url, method, body }) => {
            if (method === 'POST' && url.endsWith('/groups')) {
                const request = body as { groupId: string; };
                return jsonResponse(groupSnapshot(request.groupId));
            }

            if (method === 'PUT' && url.endsWith('/groups/rallar/sessions/session-1')) {
                return jsonResponse(groupSnapshot('rallar'));
            }

            return notFoundResponse();
        });

        const result = await createAndJoinStateGroup({
            displayName: 'Rallar',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1',
            requestedGroupId: 'rallar'
        });

        expect(result.group.groupId).toBe('rallar');
        expect(fetchCalls.map((call) => call.method)).toEqual(['POST', 'PUT']);
        expect(fetchCalls[0].body).toMatchObject({
            groupId: 'rallar',
            slug: 'rallar',
            displayName: 'Rallar',
            createdByPrincipalId: 'principal-1'
        });
    });

    it('passes optional safe create fields through create-and-join', async () => {
        stubFetch(({ url, method, body }) => {
            if (method === 'POST' && url.endsWith('/groups')) {
                const request = body as { groupId: string; };
                return jsonResponse(groupSnapshot(request.groupId));
            }

            if (method === 'PUT' && url.endsWith('/groups/rallar/sessions/session-1')) {
                return jsonResponse(groupSnapshot('rallar'));
            }

            return notFoundResponse();
        });

        await createAndJoinStateGroup({
            displayName: 'Rallar',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1',
            requestedGroupId: 'rallar',
            options: {
                description: 'Mission room',
                joinMode: 'open',
                maxMembers: 8,
                maxSessionsPerMember: 2,
                metadata: { map: 'fjord' }
            }
        });

        expect(fetchCalls[0].body).toMatchObject({
            description: 'Mission room',
            joinMode: 'open',
            maxMembers: 8,
            maxSessionsPerMember: 2,
            metadata: { map: 'fjord' }
        });
    });

    it('updates group metadata by reading and merging current metadata', async () => {
        const base = groupSnapshot('group-1');
        const existing = {
            ...base,
            group: {
                ...base.group,
                metadata: {
                    keep: true,
                    rallarDirector: { old: true }
                }
            }
        };
        const updated = {
            ...existing,
            group: {
                ...existing.group,
                metadata: {
                    keep: true,
                    rallarDirector: { next: true }
                }
            }
        };
        stubFetch(({ url, method }) => {
            if (method === 'GET' && url.endsWith('/groups/group-1')) {
                return groupPointResponse(existing);
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1')) {
                return jsonResponse(updated);
            }

            return notFoundResponse();
        });

        const result = await updateStateGroupMetadata({
            groupId: 'group-1',
            patch: { rallarDirector: { next: true } },
            principalId: 'principal-1',
            sessionId: 'session-1'
        });

        expect(result).toEqual(updated);
        expect(fetchCalls.map((call) => call.method)).toEqual(['GET', 'PUT']);
        expect(fetchCalls[1].body).toMatchObject({
            actorPrincipalId: 'principal-1',
            actorSessionId: 'session-1',
            metadata: {
                keep: true,
                rallarDirector: { next: true }
            }
        });
    });

    it('updates archives and deletes state groups through low-level workflows', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'PUT' && url.endsWith('/groups/group-1')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await updateStateGroupDetails({
            groupId: 'group-1',
            request: {
                displayName: 'Renamed',
                description: 'Mission room',
                joinMode: 'open',
                maxMembers: 8,
                maxSessionsPerMember: 2,
                metadata: { map: 'fjord' }
            },
            principalId: 'owner-1',
            sessionId: 'owner-session'
        });
        await archiveStateGroup({
            groupId: 'group-1',
            request: {},
            principalId: 'owner-1',
            sessionId: 'owner-session'
        });
        await deleteStateGroup({
            groupId: 'group-1',
            request: {},
            principalId: 'owner-1',
            sessionId: 'owner-session'
        });

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1'
        ]);
        expect(fetchCalls[0].body).toMatchObject({
            displayName: 'Renamed',
            description: 'Mission room',
            joinMode: 'open',
            maxMembers: 8,
            maxSessionsPerMember: 2,
            metadata: { map: 'fjord' },
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session'
        });
        expect(fetchCalls[1].body).toMatchObject({
            status: 'archived',
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session'
        });
        expect(fetchCalls[2].body).toMatchObject({
            status: 'deleted',
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session'
        });
    });

    it('reuses state group workflow request IDs across HTTP command retries', async () => {
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('group-retry' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('create-request-00000001' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('presence-request-000001' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValue('unused-request-0000001' as ReturnType<typeof crypto.randomUUID>);
        let createAttempts = 0;
        let presenceAttempts = 0;
        stubFetch(({ url, method, body }) => {
            if (method === 'POST' && url.endsWith('/groups')) {
                createAttempts += 1;
                if (createAttempts === 1) {
                    return textResponse('transient create failure', 503);
                }

                return jsonResponse(groupSnapshot((body as { groupId: string; }).groupId));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-retry/sessions/session-1')) {
                presenceAttempts += 1;
                if (presenceAttempts === 1) {
                    return textResponse('transient presence failure', 503);
                }

                return jsonResponse(groupSnapshot('group-retry'));
            }

            return notFoundResponse();
        });

        await createAndJoinStateGroup({
            displayName: 'Retry Room',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1',
            policies: { command: { maxAttempts: 2 } }
        });

        const createRequestIds = fetchCalls
            .filter((call) => call.method === 'POST' && call.url.endsWith('/groups'))
            .map((call) => readMutationRequestId(call.physicalUrl));
        const presenceRequestIds = fetchCalls
            .filter(
                (call) => call.method === 'PUT' && call.url.endsWith('/groups/group-retry/sessions/session-1')
            )
            .map((call) => readMutationRequestId(call.physicalUrl));

        expect(createRequestIds).toHaveLength(2);
        expect(new Set(createRequestIds).size).toBe(1);
        expect(createRequestIds[0]).toBe('create-request-00000001');
        expect(presenceRequestIds).toHaveLength(2);
        expect(new Set(presenceRequestIds).size).toBe(1);
        expect(presenceRequestIds[0]).toBe('presence-request-000001');
        expect(createRequestIds[0]).not.toBe(presenceRequestIds[0]);
    });

    it('generates opaque workflow IDs without target or caller data', async () => {
        const generatedIds = [
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222'
        ] as const;
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce(generatedIds[0])
            .mockReturnValueOnce(generatedIds[1]);
        stubFetch(({ url, method, body }) => {
            if (method === 'POST' && url.endsWith('/groups')) {
                return jsonResponse(groupSnapshot((body as { groupId: string; }).groupId));
            }
            if (
                method === 'PUT' &&
                url.endsWith('/groups/private-target-group/sessions/private-session-id')
            ) {
                return jsonResponse(groupSnapshot('private-target-group'));
            }
            return notFoundResponse();
        });

        await createAndJoinStateGroup({
            displayName: 'Private Room',
            principalId: 'private-principal-id',
            sessionId: 'private-session-id',
            generationId: 'private-generation-id',
            requestedGroupId: 'private-target-group'
        });

        const requestIds = fetchCalls.map((call) => readMutationRequestId(call.physicalUrl));
        expect(requestIds).toEqual(generatedIds);
        expect(
            requestIds.every(
                (requestId) =>
                    !requestId?.includes('private') &&
                    !requestId?.includes('principal') &&
                    !requestId?.includes('session')
            )
        ).toBe(true);
        expect(fetchCalls.every((call) => !hasRequestId(call.body))).toBe(true);
    });

    it('joins a state group with explicit join intent before connecting presence', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/join')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/session-1')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await expect(
            joinStateGroup({
                groupId: 'group-1',
                principalId: 'principal-1',
                sessionId: 'session-1',
                generationId: 'generation-1',
                intent: {
                    inviteToken: 'invite-1',
                    joinCode: 'code-1'
                }
            })
        ).resolves.toMatchObject({
            group: { groupId: 'group-1' }
        });

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/join',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1/sessions/session-1'
        ]);
        expect(fetchCalls[0].body).toMatchObject({
            inviteToken: 'invite-1',
            joinCode: 'code-1',
            actorPrincipalId: 'principal-1',
            actorSessionId: 'session-1'
        });
        expect(fetchCalls[1].body).toMatchObject({
            generationId: 'generation-1'
        });
    });

    it(
        'surfaces full-room policy codes from join workflows ' + 'without connecting presence',
        async () => {
            stubFetch(({ url, method }) => {
                if (method === 'POST' && url.endsWith('/groups/group-1/join')) {
                    return jsonResponse(
                        {
                            error: 'Forbidden: Group member capacity has been reached.',
                            code: 'group-full',
                            message: 'Group member capacity has been reached.'
                        },
                        403
                    );
                }

                return notFoundResponse();
            });

            await expect(
                joinStateGroup({
                    groupId: 'group-1',
                    principalId: 'principal-1',
                    sessionId: 'session-1',
                    generationId: 'generation-1'
                })
            ).rejects.toMatchObject({
                status: 403,
                policyError: {
                    code: 'group-full',
                    message: 'Group member capacity has been reached.'
                }
            });

            expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
                'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/join'
            ]);
        }
    );

    it('surfaces session-limit policy codes from join presence workflows', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/join')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/session-1')) {
                return jsonResponse(
                    {
                        error: 'Forbidden: Group member session capacity has been reached.',
                        code: 'member-session-limit-reached',
                        message: 'Group member session capacity has been reached.'
                    },
                    403
                );
            }

            return notFoundResponse();
        });

        await expect(
            joinStateGroup({
                groupId: 'group-1',
                principalId: 'principal-1',
                sessionId: 'session-1',
                generationId: 'generation-1'
            })
        ).rejects.toMatchObject({
            status: 403,
            policyError: {
                code: 'member-session-limit-reached',
                message: 'Group member session capacity has been reached.'
            }
        });

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/join',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1/sessions/session-1'
        ]);
    });

    it('creates and revokes state group invites through low-level workflows', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/invites/member-1')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'POST' && url.endsWith('/groups/group-1/invites/member-1/revoke')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await createStateGroupInvite({
            groupId: 'group-1',
            targetPrincipalId: 'member-1',
            request: { invitationExpiresAtEpochMs: 2_000 },
            actorPrincipalId: 'owner-1',
            sessionId: 'owner-session'
        });
        await revokeStateGroupInvite({
            groupId: 'group-1',
            targetPrincipalId: 'member-1',
            request: {},
            actorPrincipalId: 'owner-1',
            sessionId: 'owner-session'
        });

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/invites/member-1',
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1' +
            '/invites/member-1/revoke'
        ]);
        expect(fetchCalls[0].body).toMatchObject({
            invitationExpiresAtEpochMs: 2_000,
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session'
        });
        expect(fetchCalls[1].body).toMatchObject({
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session'
        });
    });

    it('ignores body request identity and allocates one opaque workflow identity', async () => {
        vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(
            'generated-appoint-request-id' as ReturnType<typeof crypto.randomUUID>
        );
        stubFetch(({ url, method }) =>
            method === 'POST' && url.endsWith('/groups/group-1/director/appoint')
                ? jsonResponse(groupSnapshot('group-1'))
                : notFoundResponse()
        );
        const requestWithCallerIdentity = {
            heartbeatTtlMs: 30_000,
            requestId: 'caller-supplied-body-id'
        } as Parameters<typeof appointStateGroupDirector>[0]['request'];

        await appointStateGroupDirector({
            groupId: 'group-1',
            request: requestWithCallerIdentity,
            principalId: 'owner-1',
            sessionId: 'owner-session'
        });

        expect(readMutationRequestId(fetchCalls[0].physicalUrl)).toBe('generated-appoint-request-id');
        expect(fetchCalls[0].body).not.toHaveProperty('requestId');
    });

    it('accepts a state group invite before connecting presence', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/invites/accept')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/member-session')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await expect(
            acceptStateGroupInvite({
                groupId: 'group-1',
                actorPrincipalId: 'member-1',
                sessionId: 'member-session',
                generationId: 'generation-1'
            })
        ).resolves.toMatchObject({
            group: { groupId: 'group-1' }
        });

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/invites/accept',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1/sessions/member-session'
        ]);
        expect(fetchCalls[0].body).toMatchObject({
            actorPrincipalId: 'member-1',
            actorSessionId: 'member-session'
        });
        expect(fetchCalls[1].body).toMatchObject({
            principalId: 'member-1',
            generationId: 'generation-1',
            actorPrincipalId: 'member-1',
            actorSessionId: 'member-session'
        });
    });

    it('rotates a state group join code through a low-level workflow', async () => {
        const response = {
            joinCode: 'code-1',
            expiresAtEpochMs: 2_000,
            snapshot: groupSnapshot('group-1')
        };
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/join-code/rotate')) {
                return jsonResponse(response);
            }

            return notFoundResponse();
        });

        await expect(
            rotateStateGroupJoinCode({
                groupId: 'group-1',
                request: {
                    joinCode: 'code-1',
                    expiresAtEpochMs: 2_000
                },
                actorPrincipalId: 'owner-1',
                sessionId: 'owner-session'
            })
        ).resolves.toEqual(response);

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/join-code/rotate'
        ]);
        expect(fetchCalls[0].body).toMatchObject({
            joinCode: 'code-1',
            expiresAtEpochMs: 2_000,
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session'
        });
    });

    it('runs membership governance through low-level workflows', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/members/member-1/remove')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'POST' && url.endsWith('/groups/group-1/members/member-1/ban')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'POST' && url.endsWith('/groups/group-1/members/member-1/unban')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/members/member-1/role')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'POST' && url.endsWith('/groups/group-1/owner/transfer')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        const memberAction = {
            groupId: 'group-1',
            targetPrincipalId: 'member-1',
            actorPrincipalId: 'owner-1',
            sessionId: 'owner-session'
        };
        await removeStateGroupMember({ ...memberAction, request: {} });
        await banStateGroupMember({ ...memberAction, request: {} });
        await unbanStateGroupMember({ ...memberAction, request: {} });
        await setStateGroupMemberRole({ ...memberAction, request: { role: 'admin' } });
        await transferStateGroupOwnership({
            groupId: 'group-1',
            request: { newOwnerPrincipalId: 'member-1' },
            actorPrincipalId: 'owner-1',
            sessionId: 'owner-session'
        });

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1' +
            '/members/member-1/remove',
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/members/member-1/ban',
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/members/member-1/unban',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1/members/member-1/role',
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/owner/transfer'
        ]);
        for (const call of fetchCalls) {
            expect(call.body).toMatchObject({
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session'
            });
        }
        expect(fetchCalls[3].body).toMatchObject({ role: 'admin' });
        expect(fetchCalls[4].body).toMatchObject({
            newOwnerPrincipalId: 'member-1'
        });
    });

    it('reuses join workflow request IDs across HTTP command retries', async () => {
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('join-request-0000000001' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('presence-request-000001' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValue('unused-request-0000001' as ReturnType<typeof crypto.randomUUID>);
        let joinAttempts = 0;
        let presenceAttempts = 0;
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/join')) {
                joinAttempts += 1;
                if (joinAttempts === 1) {
                    return textResponse('transient join failure', 503);
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/session-1')) {
                presenceAttempts += 1;
                if (presenceAttempts === 1) {
                    return textResponse('transient presence failure', 503);
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await joinStateGroup({
            groupId: 'group-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1',
            policies: { command: { maxAttempts: 2 } }
        });

        const joinRequestIds = fetchCalls
            .filter((call) => call.method === 'POST' && call.url.endsWith('/groups/group-1/join'))
            .map((call) => readMutationRequestId(call.physicalUrl));
        const presenceRequestIds = fetchCalls
            .filter(
                (call) => call.method === 'PUT' && call.url.endsWith('/groups/group-1/sessions/session-1')
            )
            .map((call) => readMutationRequestId(call.physicalUrl));

        expect(joinRequestIds).toHaveLength(2);
        expect(new Set(joinRequestIds).size).toBe(1);
        expect(joinRequestIds[0]).toBe('join-request-0000000001');
        expect(presenceRequestIds).toHaveLength(2);
        expect(new Set(presenceRequestIds).size).toBe(1);
        expect(presenceRequestIds[0]).toBe('presence-request-000001');
        expect(joinRequestIds[0]).not.toBe(presenceRequestIds[0]);
    });

    it('continues leave workflow when disconnect presence has already gone away', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/disconnect')) {
                return textResponse('missing', 404);
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/members/principal-1')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        const result = await leaveStateGroup({
            groupId: 'group-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1'
        });

        expect(result.group.groupId).toBe('group-1');
        expect(fetchCalls.map((call) => call.method)).toEqual(['POST', 'PUT']);
        expect(fetchCalls[0].body).toMatchObject({
            generationId: 'generation-1'
        });
        expect(fetchCalls[1].body).toMatchObject({
            status: 'left',
            reason: 'left-group'
        });
        expect(fetchCalls.every((call) => !hasRequestId(call.body))).toBe(true);
    });

    it('reuses leave workflow request IDs across HTTP command retries', async () => {
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('disconnect-request-000001' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('member-request-00000001' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValue('unused-request-0000001' as ReturnType<typeof crypto.randomUUID>);
        let disconnectAttempts = 0;
        let memberAttempts = 0;
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/disconnect')) {
                disconnectAttempts += 1;
                if (disconnectAttempts === 1) {
                    return textResponse('transient disconnect failure', 503);
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/members/principal-1')) {
                memberAttempts += 1;
                if (memberAttempts === 1) {
                    return textResponse('transient member failure', 503);
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await leaveStateGroup({
            groupId: 'group-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1',
            policies: { command: { maxAttempts: 2 } }
        });

        const disconnectRequestIds = fetchCalls
            .filter((call) => call.method === 'POST' && call.url.endsWith('/disconnect'))
            .map((call) => readMutationRequestId(call.physicalUrl));
        const memberRequestIds = fetchCalls
            .filter(
                (call) => call.method === 'PUT' && call.url.endsWith('/groups/group-1/members/principal-1')
            )
            .map((call) => readMutationRequestId(call.physicalUrl));

        expect(disconnectRequestIds).toHaveLength(2);
        expect(new Set(disconnectRequestIds).size).toBe(1);
        expect(disconnectRequestIds[0]).toBe('disconnect-request-000001');
        expect(memberRequestIds).toHaveLength(2);
        expect(new Set(memberRequestIds).size).toBe(1);
        expect(memberRequestIds[0]).toBe('member-request-00000001');
        expect(disconnectRequestIds[0]).not.toBe(memberRequestIds[0]);
    });

    function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): void {
        vi.stubGlobal(
            'fetch',
            vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
                const physicalUrl = String(input);
                const call: FetchCall = {
                    url: physicalUrl.startsWith('/api/state/')
                        ? withoutMutationRequestPath(physicalUrl)
                        : physicalUrl,
                    physicalUrl,
                    method: init?.method ?? 'GET',
                    headers: Object.fromEntries(new Headers(init?.headers).entries()),
                    body: init?.body ? JSON.parse(String(init.body)) : undefined,
                    signal: init?.signal
                };
                fetchCalls.push(call);
                return handler(call);
            })
        );
    }
});

function jsonResponse(body: object, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}

function groupPointResponse(body: GroupSnapshot): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            'cache-control': 'no-store',
            'content-type': 'application/json',
            'rallar-state-source': 'durable',
            'rallar-group-revision': String(body.causalRevision.groupRevision),
            'rallar-presence-revision': String(body.causalRevision.presenceRevision)
        }
    });
}

function textResponse(body: string, status: number): Response {
    return new Response(body, { status });
}

function notFoundResponse(): Response {
    return textResponse('not found', 404);
}

function groupSnapshot(groupId: string, applicationId = 'rallar-server'): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId,
        workspaceId: 'default',
        groupId,
        sessionIds: []
    });
    const groupRevision = 3;
    return {
        ...snapshot,
        causalRevision: {
            ...snapshot.causalRevision,
            groupRevision
        },
        group: {
            ...snapshot.group,
            slug: groupId,
            joinMode: 'invite-only',
            snapshotVersion: groupRevision,
            metadataVersion: 1
        }
    };
}

function withoutMutationRequestPath(url: string): string {
    return url.replace(/\/requests\/[A-Za-z0-9_-]+$/u, '');
}

function readMutationRequestId(url: string): string | undefined {
    return url.match(/\/requests\/([A-Za-z0-9_-]+)$/u)?.[1];
}

function hasRequestId<Value>(value: Value): boolean {
    return typeof value === 'object' && value !== null && 'requestId' in value;
}

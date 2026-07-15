import { describe, expect, it } from 'vitest';
import {
    blackBoxRallarAuthenticationIdentityOf,
    blackBoxRallarConnectionOperationKeyOf,
    blackBoxRallarConnectionTargetOf,
    decideBlackBoxRallarLifecycleRequest,
    isSameBlackBoxRallarSession,
    mergeBlackBoxRallarAuthenticationConfig,
    normalizeBlackBoxRallarApiBaseUrl,
} from '../../shared-test/black-box-runner/browser/rallar-browser-runtime/policy.ts';

describe('browser Rallar runtime lifecycle policy', () => {
    it('normalizes API and effective authentication identity deterministically', () => {
        expect(normalizeBlackBoxRallarApiBaseUrl('  https://api.example.test///  ')).toBe('https://api.example.test');
        expect(
            blackBoxRallarAuthenticationIdentityOf(
                {
                    apiBaseUrl: 'https://api.example.test/',
                },
                {
                    username: 'restored-user',
                },
            ),
        ).toEqual({
            apiBaseUrl: 'https://api.example.test',
            username: 'restored-user',
        });
    });

    it('includes scope and room identity in the connection target', () => {
        expect(
            blackBoxRallarConnectionTargetOf({
                roomId: 'room-1',
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                },
                rallar: {
                    apiBaseUrl: 'https://api.example.test/',
                    username: 'alice',
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                },
            }),
        ).toEqual({
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            roomId: 'room-1',
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
        });
    });

    it('distinguishes connection targets expressed through rallar.scope', () => {
        const first = blackBoxRallarConnectionTargetOf({
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                },
            },
        });
        const second = blackBoxRallarConnectionTargetOf({
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                scope: {
                    applicationId: 'app-2',
                    workspaceId: 'workspace-2',
                },
            },
        });

        expect(first).toMatchObject({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
        expect(second).toMatchObject({
            applicationId: 'app-2',
            workspaceId: 'workspace-2',
        });
        expect(first).not.toEqual(second);
    });

    it('uses the same room reference precedence as runtime operations', () => {
        expect(
            blackBoxRallarConnectionTargetOf({
                roomRef: {
                    applicationId: 'outer-app',
                    workspaceId: 'outer-workspace',
                    groupId: 'outer-room',
                },
                rallar: {
                    apiBaseUrl: 'https://api.example.test',
                    username: 'alice',
                    roomRef: {
                        applicationId: 'runtime-app',
                        workspaceId: 'runtime-workspace',
                        groupId: 'runtime-room',
                    },
                },
            }),
        ).toEqual({
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            applicationId: 'runtime-app',
            workspaceId: 'runtime-workspace',
            roomRef: {
                applicationId: 'runtime-app',
                workspaceId: 'runtime-workspace',
                groupId: 'runtime-room',
            },
        });
    });

    it('keys connection work by behavior as well as lifecycle target', () => {
        const base = {
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test/',
                username: 'alice',
                password: 'secret',
            },
        };

        const realtimeKey = blackBoxRallarConnectionOperationKeyOf({
            ...base,
            rallar: {
                ...base.rallar,
                transport: 'realtime',
            },
        });
        const messagesKey = blackBoxRallarConnectionOperationKeyOf({
            ...base,
            rallar: {
                ...base.rallar,
                transport: 'messages.rtc',
            },
        });

        expect(realtimeKey).not.toBe(messagesKey);
        expect(realtimeKey).toBe(
            blackBoxRallarConnectionOperationKeyOf({
                roomId: 'room-1',
                actor: 'alice',
                connection: 'aliceRtc',
                rallar: {
                    password: 'secret',
                    username: 'alice',
                    transport: 'realtime',
                    apiBaseUrl: 'https://api.example.test',
                },
            }),
        );
    });

    it('merges authentication cleanup policy independently of caller order', () => {
        const cleanupRequired = {
            connection: 'firstHttp',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                logoutOnClose: true,
            },
        };
        const latestContext = {
            connection: 'secondHttp',
            actor: 'second-actor',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                logoutOnClose: false,
            },
        };

        expect(
            mergeBlackBoxRallarAuthenticationConfig(cleanupRequired, latestContext),
        ).toEqual({
            ...latestContext,
            rallar: {
                ...latestContext.rallar,
                logoutOnClose: true,
            },
        });
        expect(
            mergeBlackBoxRallarAuthenticationConfig(latestContext, cleanupRequired),
        ).toEqual(cleanupRequired);
    });

    it('reuses matching lifecycle work and rejects connected target changes', () => {
        const target = blackBoxRallarConnectionTargetOf({
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
            },
        });

        expect(
            decideBlackBoxRallarLifecycleRequest(
                {
                    status: 'connecting',
                    activeTarget: target,
                },
                {
                    kind: 'connect',
                    target,
                },
            ),
        ).toEqual({ kind: 'reuse' });
        expect(
            decideBlackBoxRallarLifecycleRequest(
                {
                    status: 'connected',
                    activeTarget: target,
                },
                {
                    kind: 'connect',
                    target: {
                        ...target,
                        roomId: 'room-2',
                    },
                },
            ),
        ).toEqual({
            kind: 'reject',
            reason: 'Connected Rallar identity, scope, or room changes require close first.',
        });
    });

    it('compares only stable session identity fields', () => {
        expect(
            isSameBlackBoxRallarSession(
                {
                    clientId: 'client-1',
                    sessionId: 'session-1',
                    username: 'alice',
                },
                {
                    clientId: 'client-1',
                    sessionId: 'session-1',
                    username: 'alice',
                },
            ),
        ).toBe(true);
        expect(
            isSameBlackBoxRallarSession(
                {
                    clientId: 'client-1',
                    sessionId: 'session-1',
                    username: 'alice',
                },
                {
                    clientId: 'client-1',
                    sessionId: 'session-2',
                    username: 'alice',
                },
            ),
        ).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';
import {
    blackBoxRallarAuthenticationIdentityOf,
    blackBoxRallarConnectionTargetOf,
    decideBlackBoxRallarLifecycleRequest,
    isSameBlackBoxRallarSession,
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

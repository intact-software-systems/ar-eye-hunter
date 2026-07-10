import { describe, expect, it } from 'vitest';
import {
    authenticateRallarBlackBox,
    authErrorMessage,
    bootstrapMatchesAuthSession,
    bootstrapPatchFromAuthSession,
    type RallarBlackBoxAuthFacade,
} from '../../../apps/rallar-black-box/src/auth-flow.ts';
import { resolveRallarBlackBoxBootstrapConfig } from '../../../apps/rallar-black-box/src/runtime-store.ts';

function session(username = 'alice') {
    return {
        clientId: `${username}-client`,
        accessToken: `${username}-token`,
        username,
        sessionId: `${username}-session`,
        expiresAtEpochMs: Date.now() + 60_000,
    };
}

describe('rallar-black-box auth flow', () => {
    it('configures Rallar and logs in with username/password', async () => {
        const calls: string[] = [];
        const loginSession = session('alice');
        const facade: RallarBlackBoxAuthFacade = {
            configure: (config) => {
                calls.push(`configure:${config.apiBaseUrl}`);
            },
            auth: {
                login: async (request) => {
                    calls.push(`login:${request.username}:${request.password}`);
                    return loginSession;
                },
                registerAndLogin: async () => {
                    throw new Error('not expected');
                },
            },
        };

        await expect(authenticateRallarBlackBox(facade, {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
        })).resolves.toBe(loginSession);
        expect(calls).toEqual([
            'configure:https://api.example.test',
            'login:alice:secret',
        ]);
    });

    it('can register and log in through the same auth path', async () => {
        const calls: string[] = [];
        const registeredSession = session('bob');
        const facade: RallarBlackBoxAuthFacade = {
            configure: (config) => {
                calls.push(`configure:${config.apiBaseUrl}`);
            },
            auth: {
                login: async () => {
                    throw new Error('not expected');
                },
                registerAndLogin: async (request) => {
                    calls.push(`register:${request.username}:${request.password}`);
                    return registeredSession;
                },
            },
        };

        await expect(authenticateRallarBlackBox(facade, {
            apiBaseUrl: 'https://api.example.test',
            username: 'bob',
            password: 'secret',
            register: true,
        })).resolves.toBe(registeredSession);
        expect(calls).toEqual([
            'configure:https://api.example.test',
            'register:bob:secret',
        ]);
    });

    it('falls back to login when register-before-login finds an existing user', async () => {
        const calls: string[] = [];
        const loginSession = session('alice');
        const facade: RallarBlackBoxAuthFacade = {
            configure: (config) => {
                calls.push(`configure:${config.apiBaseUrl}`);
            },
            auth: {
                login: async (request) => {
                    calls.push(`login:${request.username}:${request.password}`);
                    return loginSession;
                },
                registerAndLogin: async (request) => {
                    calls.push(`register:${request.username}:${request.password}`);
                    throw new Error(
                        'API POST /api/auth/register failed: 409 {"error":"Auth user already exists: alice"}',
                    );
                },
            },
        };

        await expect(authenticateRallarBlackBox(facade, {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            register: true,
        })).resolves.toBe(loginSession);
        expect(calls).toEqual([
            'configure:https://api.example.test',
            'register:alice:secret',
            'login:alice:secret',
        ]);
    });

    it('creates a restore-session bootstrap patch after login', () => {
        expect(bootstrapPatchFromAuthSession(session('alice'), 'https://api.example.test'))
            .toMatchObject({
                apiBaseUrl: 'https://api.example.test',
                actor: 'alice',
                sessionId: 'alice-session',
                rallarUsername: 'alice',
                rallarRegister: false,
                rallarRestoreSession: true,
            });
    });

    it('recognizes only the exact auth-session bootstrap merge as ready', () => {
        const authSession = session('alice');
        const initial = resolveRallarBlackBoxBootstrapConfig(
            '?provider=browser-rallar&apiBaseUrl=https%3A%2F%2Fapi.example.test',
            {},
        );
        expect(bootstrapMatchesAuthSession(initial, authSession)).toBe(false);

        const ready = {
            ...initial,
            ...bootstrapPatchFromAuthSession(
                authSession,
                'https://api.example.test',
            ),
        };
        expect(bootstrapMatchesAuthSession(ready, authSession)).toBe(true);
        expect(bootstrapMatchesAuthSession(
            { ...ready, actor: 'mallory' },
            authSession,
        )).toBe(false);
        expect(bootstrapMatchesAuthSession(
            { ...ready, sessionId: 'other-session' },
            authSession,
        )).toBe(false);
        expect(bootstrapMatchesAuthSession(
            { ...ready, rallarUsername: 'mallory' },
            authSession,
        )).toBe(false);
        expect(bootstrapMatchesAuthSession(
            { ...ready, rallarPassword: 'retained-secret' },
            authSession,
        )).toBe(false);
        expect(bootstrapMatchesAuthSession(
            { ...ready, rallarRegister: true },
            authSession,
        )).toBe(false);
        expect(bootstrapMatchesAuthSession(
            { ...ready, rallarRestoreSession: false },
            authSession,
        )).toBe(false);
    });

    it('classifies common login failures', () => {
        expect(authErrorMessage(new Error('Failed to fetch'))).toContain('CORS');
        expect(authErrorMessage(new Error('API POST /api/auth/login failed: 401')))
            .toBe('Invalid username or password.');
        expect(authErrorMessage(new Error('API POST /api/auth/login failed: 403')))
            .toBe('Login is forbidden for this user.');
    });
});

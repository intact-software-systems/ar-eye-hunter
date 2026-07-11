import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '../../shared/api/api-config.ts';
import { resolveRallarBlackBoxBootstrapConfig } from '../../shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type {
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState,
} from '../../shared-test/rallar-bb-test/types.ts';
import { DEFAULT_MANUAL_WORKBENCH_VALUES } from '../../../apps/rallar-black-box/src/manual-workbench.ts';
import {
    deriveQueue,
    findSelectedResult,
} from '../../../apps/rallar-black-box/src/legacy/runner/shell/runner-shell-model.ts';
import {
    bootstrapPatchFromGlobalValues,
    commandCenterGlobalValuesFromState,
    sameCommandCenterGlobalValues,
} from '../../../apps/rallar-black-box/src/legacy/shell/global-context-model.ts';

const ticketMocks = vi.hoisted(() => ({
    configureApiClient: vi.fn(),
    consumeAgentSessionTicket: vi.fn(),
}));

vi.mock('@shared-web/browser/api-client-config.ts', () => ({
    configureApiClient: ticketMocks.configureApiClient,
}));
vi.mock('@shared-web/browser/api-integration.ts', () => ({
    consumeAgentSessionTicket: ticketMocks.consumeAgentSessionTicket,
}));

import {
    consumeBootstrapAgentSessionTicket,
    scrubAgentSessionTicketFromUrl,
} from '../../../apps/rallar-black-box/src/legacy/shell/auth/agent-session-ticket.ts';

function result(
    commandId: string,
    ok: boolean,
): RallarBlackBoxTestResult {
    return {
        commandId,
        kind: 'health',
        status: ok ? 'ok' : 'failed',
        ok,
        startedAtEpochMs: 10,
        endedAtEpochMs: 20,
        durationMs: 10,
    };
}

function state(
    overrides: Partial<RallarBlackBoxTestState> = {},
): RallarBlackBoxTestState {
    return {
        status: 'idle',
        commandHistory: [],
        events: [],
        failures: [],
        resultCache: {},
        ...overrides,
    };
}

afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe('legacy runner shell models', () => {
    it('derives pending, running, completed, and failed queue rows', () => {
        const completed = result('completed', true);
        const failed = result('failed', false);
        const running = {
            kind: 'wait',
            commandId: 'running',
            label: 'Active wait',
            timeoutMs: 250,
            match: { kind: 'diagnostic' },
        } as const;

        expect(deriveQueue(state({
            loadedRecipe: {
                recipeId: 'queue-fixture',
                commands: [
                    { kind: 'health', label: 'Pending health' },
                    running,
                    { kind: 'health', commandId: 'completed' },
                    { kind: 'health', commandId: 'failed' },
                ],
            },
            activeCommand: running,
            resultCache: { completed, failed },
        }))).toEqual([
            {
                id: 'health-1',
                kind: 'health',
                label: 'Pending health',
                timeoutMs: undefined,
                status: 'pending',
            },
            {
                id: 'running',
                kind: 'wait',
                label: 'Active wait',
                timeoutMs: 250,
                status: 'running',
            },
            {
                id: 'completed',
                kind: 'health',
                label: 'health',
                timeoutMs: undefined,
                status: 'completed',
            },
            {
                id: 'failed',
                kind: 'health',
                label: 'health',
                timeoutMs: undefined,
                status: 'failed',
            },
        ]);
    });

    it('selects an exact result and falls back to the latest result', () => {
        const first = result('first', true);
        const latest = result('latest', false);
        const history = [first, latest];

        expect(findSelectedResult(history, 'first')).toBe(first);
        expect(findSelectedResult(history, 'missing')).toBe(latest);
        expect(findSelectedResult(history, undefined)).toBe(latest);
        expect(findSelectedResult([], undefined)).toBeUndefined();
    });
});

describe('legacy global-context model', () => {
    const bootstrap = resolveRallarBlackBoxBootstrapConfig(
        '?apiBaseUrl=https%3A%2F%2Fbootstrap.example.test&actor=bootstrap-actor&sessionId=bootstrap-session&roomId=bootstrap-room',
        {},
        '',
    );

    it('derives values using auth, config, bootstrap, and manual-default precedence', () => {
        const authSession: AuthSession = {
            clientId: 'auth-client',
            accessToken: 'access-token',
            username: 'auth-user',
            sessionId: 'auth-session',
            expiresAtEpochMs: 9_999,
        };

        expect(commandCenterGlobalValuesFromState(state({
            currentConfig: {
                apiBaseUrl: 'https://config.example.test',
                actor: 'config-actor',
                sessionId: 'config-session',
                roomId: 'config-room',
                defaults: { applicationId: 'config-app' },
                rallar: { workspaceId: 'rallar-workspace' },
            },
        }), bootstrap, authSession)).toEqual({
            apiBaseUrl: 'https://config.example.test',
            applicationId: 'config-app',
            workspaceId: 'rallar-workspace',
            clientId: 'auth-client',
            sessionId: 'auth-session',
            roomId: 'config-room',
        });

        expect(commandCenterGlobalValuesFromState(state(), bootstrap)).toEqual({
            apiBaseUrl: bootstrap.apiBaseUrl,
            applicationId: DEFAULT_MANUAL_WORKBENCH_VALUES.applicationId,
            workspaceId: DEFAULT_MANUAL_WORKBENCH_VALUES.workspaceId,
            clientId: bootstrap.actor,
            sessionId: bootstrap.sessionId,
            roomId: bootstrap.roomId,
        });
    });

    it('compares all global values and creates the minimal bootstrap patch', () => {
        const values = {
            apiBaseUrl: 'https://api.example.test',
            applicationId: 'application-a',
            workspaceId: 'workspace-a',
            clientId: 'client-a',
            sessionId: 'session-a',
            roomId: 'room-a',
        };

        expect(sameCommandCenterGlobalValues(values, { ...values })).toBe(true);
        for (const key of Object.keys(values) as (keyof typeof values)[]) {
            expect(
                sameCommandCenterGlobalValues(values, {
                    ...values,
                    [key]: `${values[key]}-changed`,
                }),
                key,
            ).toBe(false);
        }
        expect(bootstrapPatchFromGlobalValues(values)).toEqual({
            apiBaseUrl: values.apiBaseUrl,
            actor: values.clientId,
            sessionId: values.sessionId,
            roomId: values.roomId,
        });
    });
});

describe('legacy agent-session ticket service', () => {
    it('scrubs only agentSessionTicket while preserving other fragment values', () => {
        const replaceState = vi.fn();
        vi.stubGlobal('window', {
            location: {
                hash: '#view=runner&agentSessionTicket=one-time-secret&run=42',
                href: 'https://runner.example.test/path?mode=control#view=runner&agentSessionTicket=one-time-secret&run=42',
            },
            history: { replaceState },
        });
        vi.stubGlobal('document', { title: 'Rallar Black Box' });

        scrubAgentSessionTicketFromUrl();

        expect(replaceState).toHaveBeenCalledOnce();
        expect(replaceState).toHaveBeenCalledWith(
            null,
            'Rallar Black Box',
            'https://runner.example.test/path?mode=control#view=runner&run=42',
        );
    });

    it('deduplicates an in-flight consume and clears the cache after settlement', async () => {
        const session: AuthSession = {
            clientId: 'agent-client',
            accessToken: 'agent-access-token',
            username: 'agent-user',
            sessionId: 'agent-session',
            expiresAtEpochMs: 9_999,
        };
        let resolveFirst!: (value: AuthSession) => void;
        const firstConsume = new Promise<AuthSession>((resolve) => {
            resolveFirst = resolve;
        });
        ticketMocks.consumeAgentSessionTicket
            .mockReturnValueOnce(firstConsume)
            .mockResolvedValueOnce(session);

        const first = consumeBootstrapAgentSessionTicket(
            'ticket-a',
            'https://api-a.example.test',
        );
        const duplicate = consumeBootstrapAgentSessionTicket(
            'ticket-a',
            'https://api-b.example.test',
        );

        expect(duplicate).toBe(first);
        expect(ticketMocks.configureApiClient).toHaveBeenCalledOnce();
        expect(ticketMocks.configureApiClient).toHaveBeenCalledWith({
            apiBaseUrl: 'https://api-a.example.test',
        });
        expect(ticketMocks.consumeAgentSessionTicket).toHaveBeenCalledOnce();
        expect(ticketMocks.consumeAgentSessionTicket).toHaveBeenCalledWith({
            ticket: 'ticket-a',
        });

        resolveFirst(session);
        await first;

        await consumeBootstrapAgentSessionTicket(
            'ticket-a',
            'https://api-c.example.test',
        );
        expect(ticketMocks.consumeAgentSessionTicket).toHaveBeenCalledTimes(2);
        expect(ticketMocks.configureApiClient).toHaveBeenNthCalledWith(2, {
            apiBaseUrl: 'https://api-c.example.test',
        });
    });

    it('clears a rejected consume from the in-flight cache', async () => {
        const session: AuthSession = {
            clientId: 'retry-client',
            accessToken: 'retry-access-token',
            username: 'retry-user',
            sessionId: 'retry-session',
            expiresAtEpochMs: 9_999,
        };
        ticketMocks.consumeAgentSessionTicket
            .mockRejectedValueOnce(new Error('ticket temporarily unavailable'))
            .mockResolvedValueOnce(session);

        await expect(consumeBootstrapAgentSessionTicket(
            'ticket-retry',
            'https://api.example.test',
        )).rejects.toThrow('ticket temporarily unavailable');
        await expect(consumeBootstrapAgentSessionTicket(
            'ticket-retry',
            'https://api.example.test',
        )).resolves.toEqual(session);

        expect(ticketMocks.consumeAgentSessionTicket).toHaveBeenCalledTimes(2);
    });
});

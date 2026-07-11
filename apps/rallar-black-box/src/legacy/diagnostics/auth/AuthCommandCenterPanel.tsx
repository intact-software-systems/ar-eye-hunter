import { useEffect, useMemo, useState } from 'react';
import type {
    AuthSession,
    WebSocketTicketResponse,
} from '@shared/api/api-config.ts';
import { clearSession } from '@shared/api/auth.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import {
    authenticateRallarBlackBox,
    authErrorMessage,
    bootstrapPatchFromAuthSession,
} from '../../../auth-flow.ts';
import { executeRallarServerRestRequest } from '../../../rallar-server-workbench.ts';
import {
    type RallarBlackBoxBootstrapConfig,
    rallarBlackBoxProviderModeFromConfig,
    rallarBlackBoxRuntimeStore,
} from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { CollapsiblePanelSection } from '../../shared/CollapsiblePanelSection.tsx';
import { recordValue as optionalRecord } from '../../shared/record-value.ts';
import {
    redactedJson,
    uiRedactionOptions,
} from '../../shared/redaction-presentation.ts';
import {
    formatDuration,
    formatRelativeDuration,
    formatTime,
} from '../../shared/time-format.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { readCurrentAuthSession } from '../../shell/read-current-auth-session.ts';
import type { AuthCommandCenterTicket } from '../shared/auth-command-center-ticket.ts';
import {
    type CommandCenterRestActionLog,
    restLogEntry,
} from '../shared/rest-action-log.ts';
import { authRecipeSnippet } from './auth-recipe.ts';

export function AuthCommandCenterPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
    onAuthenticated,
    onLogout,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    onAuthenticated(session?: AuthSession): void;
    onLogout(): Promise<void>;
}) {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const providerMode = rallarBlackBoxProviderModeFromConfig(config);
    const [apiBaseUrl, setApiBaseUrl] = useState(
        globalValues?.apiBaseUrl ?? config?.apiBaseUrl ?? bootstrap.apiBaseUrl,
    );
    const [username, setUsername] = useState(
        authSession?.username ?? bootstrap.rallarUsername ?? bootstrap.actor,
    );
    const [password, setPassword] = useState(bootstrap.rallarPassword ?? '');
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [ticket, setTicket] = useState<AuthCommandCenterTicket | undefined>();
    const [actions, setActions] = useState<
        readonly CommandCenterRestActionLog[]
    >([]);
    const recipeText = useMemo(() => authRecipeSnippet(username), [username]);
    const diagnosticsText = useMemo(
        () =>
            redactedJson(
                {
                    providerMode,
                    apiBaseUrl,
                    session: authSession,
                    wsTicket: ticket
                        ? {
                              ...ticket,
                              ticket: '<redacted:ws-ticket>',
                              expiresInMs: ticket.expiresAtEpochMs - Date.now(),
                          }
                        : undefined,
                    recentActions: actions.slice(-6),
                },
                state,
                authSession,
            ),
        [actions, apiBaseUrl, authSession, providerMode, state, ticket],
    );
    const sessionExpiresInMs = authSession
        ? authSession.expiresAtEpochMs - Date.now()
        : undefined;
    const wsTicketExpiresInMs = ticket
        ? ticket.expiresAtEpochMs - Date.now()
        : undefined;

    const appendAction = (entry: CommandCenterRestActionLog): void => {
        setActions((current) => [...current, entry].slice(-12));
    };

    useEffect(() => {
        if (globalValues?.apiBaseUrl) {
            setApiBaseUrl(globalValues.apiBaseUrl);
        }
    }, [globalValues?.apiBaseUrl]);

    const runWithBusy = async (
        label: string,
        action: () => Promise<void>,
    ): Promise<void> => {
        setBusyAction(label);
        setLocalError(undefined);
        try {
            await action();
        } catch (error) {
            setLocalError(authErrorMessage(error));
        } finally {
            setBusyAction(undefined);
        }
    };

    const login = async (register: boolean): Promise<void> => {
        await runWithBusy(
            register ? 'Register and login' : 'Login',
            async () => {
                const session = await authenticateRallarBlackBox(
                    await loadBrowserRallarFacade(),
                    {
                        apiBaseUrl,
                        username,
                        password,
                        register,
                    },
                );
                rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                    bootstrapPatchFromAuthSession(session, apiBaseUrl),
                );
                onAuthenticated(session);
                appendAction({
                    actionId: `auth-${register ? 'register-login' : 'login'}-${Date.now()}`,
                    label: register ? 'Register and login' : 'Login',
                    atEpochMs: Date.now(),
                    ok: true,
                    status: register ? 201 : 200,
                    statusText: 'OK',
                    durationMs: 0,
                    bodyJson: session,
                });
            },
        );
    };

    const restore = (): void => {
        const restored = readCurrentAuthSession();
        onAuthenticated(restored);
        if (!restored) {
            setLocalError('No restorable browser auth session was found.');
            return;
        }
        rallarBlackBoxRuntimeStore.updateBootstrapConfig(
            bootstrapPatchFromAuthSession(restored, apiBaseUrl),
        );
        appendAction({
            actionId: `auth-restore-${Date.now()}`,
            label: 'Restore session',
            atEpochMs: Date.now(),
            ok: true,
            status: 200,
            statusText: 'Restored',
            durationMs: 0,
            bodyJson: restored,
        });
    };

    const clearLocal = (): void => {
        clearSession();
        setTicket(undefined);
        onAuthenticated(undefined);
        appendAction({
            actionId: `auth-clear-${Date.now()}`,
            label: 'Clear local session',
            atEpochMs: Date.now(),
            ok: true,
            status: 200,
            statusText: 'Cleared',
            durationMs: 0,
        });
    };

    const createWsTicket = async (): Promise<void> => {
        await runWithBusy('Create WS ticket', async () => {
            const response = await executeRallarServerRestRequest({
                apiBaseUrl,
                method: 'POST',
                path: '/api/auth/ws-ticket',
                headersText: '{}',
                queryText: '{}',
                bodyText: '{}',
                responseBodyMode: 'json',
                attachAuth: true,
                authSession,
                timeoutMs: 5_000,
            });
            appendAction(restLogEntry('Create WS ticket', response));
            const body = optionalRecord(response.bodyJson);
            if (
                response.ok &&
                typeof body.ticket === 'string' &&
                typeof body.sessionId === 'string' &&
                typeof body.expiresAtEpochMs === 'number'
            ) {
                const wsTicket = body as WebSocketTicketResponse;
                setTicket({
                    ticket: wsTicket.ticket,
                    sessionId: wsTicket.sessionId,
                    expiresAtEpochMs: wsTicket.expiresAtEpochMs,
                    issuedAtEpochMs: Date.now(),
                });
            }
        });
    };

    const negativeWsTicket = async (): Promise<void> => {
        await runWithBusy('Missing auth WS ticket', async () => {
            const response = await executeRallarServerRestRequest({
                apiBaseUrl,
                method: 'POST',
                path: '/api/auth/ws-ticket',
                headersText: '{}',
                queryText: '{}',
                bodyText: '{}',
                responseBodyMode: 'json',
                attachAuth: false,
                timeoutMs: 5_000,
            });
            appendAction(restLogEntry('Missing auth WS ticket', response));
        });
    };

    const expiredWsTicket = async (): Promise<void> => {
        await runWithBusy('Expired auth WS ticket', async () => {
            const expiredSession = authSession
                ? {
                      ...authSession,
                      expiresAtEpochMs: Date.now() - 1_000,
                  }
                : undefined;
            const response = await executeRallarServerRestRequest({
                apiBaseUrl,
                method: 'POST',
                path: '/api/auth/ws-ticket',
                headersText: '{}',
                queryText: '{}',
                bodyText: '{}',
                responseBodyMode: 'json',
                attachAuth: true,
                authSession: expiredSession,
                timeoutMs: 5_000,
            });
            appendAction(restLogEntry('Expired auth WS ticket', response));
        });
    };

    const negativeLogin = async (): Promise<void> => {
        await runWithBusy('Bad credentials', async () => {
            const response = await executeRallarServerRestRequest({
                apiBaseUrl,
                method: 'POST',
                path: '/api/auth/login',
                headersText: '{}',
                queryText: '{}',
                bodyText: JSON.stringify({
                    username: username || 'unknown',
                    password: `${password || 'bad'}-invalid`,
                }),
                responseBodyMode: 'json',
                attachAuth: false,
                timeoutMs: 5_000,
            });
            appendAction(restLogEntry('Bad credentials', response));
        });
    };

    const copyDiagnostics = (): void => {
        void navigator.clipboard?.writeText(diagnosticsText);
    };

    const copyRecipe = (): void => {
        void navigator.clipboard?.writeText(recipeText);
    };

    return (
        <section className="panel auth-command-center-panel">
            <div className="panel-heading">
                <h2>Auth Command Center</h2>
                <span className={`pill ${authSession ? 'good' : 'warn'}`}>
                    {authSession ? 'session active' : 'no session'}
                </span>
            </div>
            <CollapsiblePanelSection
                title="Auth Inputs"
                meta={authSession ? authSession.username : 'not logged in'}
            >
                <div className="auth-command-grid">
                    <label className="field">
                        <span>API Base URL</span>
                        <input
                            value={apiBaseUrl}
                            onChange={(event) =>
                                setApiBaseUrl(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Username</span>
                        <input
                            value={username}
                            onChange={(event) =>
                                setUsername(event.target.value)
                            }
                            autoCapitalize="none"
                            autoComplete="username"
                            autoCorrect="off"
                            spellCheck={false}
                        />
                    </label>
                    <label className="field">
                        <span>Password</span>
                        <input
                            type="password"
                            value={password}
                            onChange={(event) =>
                                setPassword(event.target.value)
                            }
                            autoComplete="current-password"
                        />
                    </label>
                </div>
            </CollapsiblePanelSection>
            <div className="auth-action-grid">
                <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={() => void login(false)}
                >
                    Login
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={() => void login(true)}
                >
                    Register and login
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={restore}
                >
                    Restore session
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction) || !authSession}
                    onClick={() => void onLogout()}
                >
                    Logout
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={clearLocal}
                >
                    Clear local session
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction) || !authSession}
                    onClick={() => void createWsTicket()}
                >
                    Create WS ticket
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={() => void negativeLogin()}
                >
                    Bad credentials
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={() => void negativeWsTicket()}
                >
                    Missing auth ticket
                </button>
                <button
                    type="button"
                    disabled={Boolean(busyAction) || !authSession}
                    onClick={() => void expiredWsTicket()}
                >
                    Expired auth ticket
                </button>
                <button type="button" onClick={copyDiagnostics}>
                    Copy diagnostics
                </button>
                <button type="button" onClick={copyRecipe}>
                    Copy auth recipe
                </button>
            </div>
            <dl className="config-list auth-session-list">
                <div>
                    <dt>Provider</dt>
                    <dd>{providerMode}</dd>
                </div>
                <div>
                    <dt>User</dt>
                    <dd>{authSession?.username ?? '-'}</dd>
                </div>
                <div>
                    <dt>Client</dt>
                    <dd>{authSession?.clientId ?? '-'}</dd>
                </div>
                <div>
                    <dt>Session</dt>
                    <dd>{authSession?.sessionId ?? '-'}</dd>
                </div>
                <div>
                    <dt>Token</dt>
                    <dd>{authSession?.accessToken ? 'redacted' : '-'}</dd>
                </div>
                <div>
                    <dt>Session expires</dt>
                    <dd>{formatTime(authSession?.expiresAtEpochMs)}</dd>
                </div>
                <div>
                    <dt>Session TTL</dt>
                    <dd>{formatRelativeDuration(sessionExpiresInMs)}</dd>
                </div>
                <div>
                    <dt>WS ticket</dt>
                    <dd>{ticket ? 'redacted' : '-'}</dd>
                </div>
                <div>
                    <dt>Ticket expires</dt>
                    <dd>{formatTime(ticket?.expiresAtEpochMs)}</dd>
                </div>
                <div>
                    <dt>Ticket TTL</dt>
                    <dd>{formatRelativeDuration(wsTicketExpiresInMs)}</dd>
                </div>
            </dl>
            <div
                className="command-center-status auth-session-guidance"
                role="note"
            >
                Ordinary same-origin tabs share localStorage `auth.session`.
                Agent tabs opened from Connect Agents use one-time links and
                sessionStorage so the same logged-in user can create distinct
                targetable browser sessions.
            </div>
            {busyAction && (
                <div className="command-center-status" role="status">
                    {busyAction}
                </div>
            )}
            {localError && (
                <div className="workbench-error" role="status">
                    {redactRallarBlackBoxValue(
                        localError,
                        uiRedactionOptions(state, authSession, [password]),
                    )}
                </div>
            )}
            <div className="command-center-action-list">
                {actions.length === 0 && (
                    <div className="empty-state">No auth actions yet</div>
                )}
                {actions
                    .slice()
                    .reverse()
                    .map((action) => (
                        <article
                            className="command-center-action-row"
                            key={action.actionId}
                        >
                            <div>
                                <strong>{action.label}</strong>
                                <small>
                                    {formatTime(action.atEpochMs)} -{' '}
                                    {formatDuration(action.durationMs)}
                                </small>
                            </div>
                            <span
                                className={`pill ${action.ok ? 'good' : 'bad'}`}
                            >
                                {action.status || action.errorKind || 'local'}
                            </span>
                            <pre className="mini-json">
                                {redactedJson(
                                    action.bodyJson ??
                                        action.errorKind ??
                                        action.statusText,
                                    state,
                                    authSession,
                                    [password],
                                )}
                            </pre>
                        </article>
                    ))}
            </div>
        </section>
    );
}

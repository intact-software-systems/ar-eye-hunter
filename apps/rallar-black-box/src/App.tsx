import { useEffect, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import { clearSession, writeSession } from '@shared/api/auth.ts';
import {
    rallarBlackBoxRuntimeStore,
    useRallarBlackBoxRuntimeStore,
} from './runtime-store.ts';
import {
    authErrorMessage,
    bootstrapPatchFromAuthSession,
} from './auth-flow.ts';
import { readAuthSessionFromRallarAuthState } from './auth-lifecycle.ts';
import { loadBrowserRallarFacade } from './legacy/rallar/load-browser-rallar-facade.ts';
import {
    useRunnerShellSelectionSync,
    useRunnerShellState,
} from './legacy/runner/shell/use-runner-shell-state.ts';
import { LegacyAppShell } from './legacy/shell/LegacyAppShell.tsx';
import { LoginScreen } from './legacy/shell/LoginScreen.tsx';
import {
    consumeBootstrapAgentSessionTicket,
    scrubAgentSessionTicketFromUrl,
} from './legacy/shell/auth/agent-session-ticket.ts';
import { readCurrentAuthSession } from './legacy/shell/read-current-auth-session.ts';
import { useCommandCenterGlobalContext } from './legacy/shell/use-command-center-global-context.ts';
import { useLegacyNavigation } from './legacy/shell/use-legacy-navigation.ts';

// Recipe Console work belongs under `src/recipe-console/**`; legacy extraction belongs under `src/legacy/**`; no new feature panel belongs in `App.tsx`.

export default function App() {
    const runtime = useRallarBlackBoxRuntimeStore();
    const { state, bootstrap } = runtime;
    const runnerSelection = useRunnerShellState(state);
    const navigation = useLegacyNavigation();
    const [authSession, setAuthSession] = useState<AuthSession | undefined>(
        () =>
            bootstrap.rallarAgentSessionTicket
                ? undefined
                : readCurrentAuthSession(),
    );
    const [authBusy, setAuthBusy] = useState(false);
    const [authError, setAuthError] = useState<string | undefined>();
    const requiresLogin = bootstrap.providerMode === 'browser-rallar';
    const canEnterApp = !requiresLogin || Boolean(authSession);

    useEffect(() => {
        if (!requiresLogin) {
            return;
        }

        let cancelled = false;
        let unsubscribe: (() => void) | undefined;
        void loadBrowserRallarFacade()
            .then((facade) => {
                if (cancelled) {
                    return;
                }

                facade.configure({ apiBaseUrl: bootstrap.apiBaseUrl });
                unsubscribe = facade.auth.onChange((state) => {
                    if (bootstrap.rallarAgentSessionTicket) {
                        return;
                    }
                    const nextSession = readAuthSessionFromRallarAuthState(state);
                    setAuthSession(nextSession);
                    if (!nextSession) {
                        setAuthBusy(false);
                    }
                }, { emitCurrent: true });
            })
            .catch(() => {
                // Connect-time diagnostics will surface configuration conflicts.
            });

        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, [bootstrap.apiBaseUrl, bootstrap.rallarAgentSessionTicket, requiresLogin]);

    useEffect(() => {
        if (requiresLogin && authSession) {
            rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                bootstrapPatchFromAuthSession(
                    authSession,
                    bootstrap.apiBaseUrl,
                ),
            );
        }
    }, [authSession, bootstrap.apiBaseUrl, requiresLogin]);

    useEffect(() => {
        if (
            !requiresLogin ||
            !bootstrap.rallarAgentSessionTicket
        ) {
            return;
        }

        let cancelled = false;
        setAuthBusy(true);
        setAuthError(undefined);

        void (async () => {
            const facade = await loadBrowserRallarFacade();
            facade.configure({ apiBaseUrl: bootstrap.apiBaseUrl });
            clearSession();
            const session = await consumeBootstrapAgentSessionTicket(
                bootstrap.rallarAgentSessionTicket ?? '',
                bootstrap.apiBaseUrl,
            );
            if (cancelled) {
                return;
            }

            writeSession(session);
            scrubAgentSessionTicketFromUrl();
            setAuthSession(session);
            setAuthBusy(false);
            rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                {
                    ...bootstrapPatchFromAuthSession(
                        session,
                        bootstrap.apiBaseUrl,
                    ),
                    rallarAgentSessionTicket: undefined,
                },
            );
        })()
            .catch((error) => {
                if (!cancelled) {
                    setAuthError(authErrorMessage(error));
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setAuthBusy(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [
        bootstrap.apiBaseUrl,
        bootstrap.rallarAgentSessionTicket,
        requiresLogin,
    ]);

    const globalContext = useCommandCenterGlobalContext({
        state,
        bootstrap,
        authSession,
    });

    useEffect(() => {
        if (canEnterApp && navigation.activeMode === 'black-box-runner') {
            rallarBlackBoxRuntimeStore.ensureBootstrapped();
        }
    }, [navigation.activeMode, canEnterApp]);

    useRunnerShellSelectionSync(runnerSelection);

    const logout = async (): Promise<void> => {
        setAuthBusy(true);
        setAuthError(undefined);
        try {
            const facade = await loadBrowserRallarFacade();
            facade.configure({ apiBaseUrl: bootstrap.apiBaseUrl });
            await facade.disconnect();
            await facade.auth.logout();
        } catch (error) {
            setAuthError(authErrorMessage(error));
        } finally {
            setAuthSession(readCurrentAuthSession());
            setAuthBusy(false);
        }
    };

    if (requiresLogin && bootstrap.rallarAgentSessionTicket) {
        return (
            <main className="auth-shell">
                <section className="auth-panel">
                    <div className="auth-heading">
                        <p className="eyebrow">Rallar Kit</p>
                        <h1>Connecting agent session</h1>
                        <span className="pill active">one-time link</span>
                    </div>
                    <p className="auth-guidance">
                        Preparing a fresh per-tab session for this agent.
                    </p>
                    {authBusy && (
                        <div className="command-center-status" role="status">
                            Consuming one-time agent ticket...
                        </div>
                    )}
                    {authError && (
                        <div className="workbench-error" role="status">
                            {authError}
                        </div>
                    )}
                </section>
            </main>
        );
    }

    if (requiresLogin && !authSession) {
        return (
            <LoginScreen
                bootstrap={bootstrap}
                onAuthenticated={(session) => {
                    setAuthError(undefined);
                    setAuthSession(session);
                }}
            />
        );
    }

    return (
        <LegacyAppShell
            runtime={runtime}
            auth={{
                authSession,
                authBusy,
                authError,
                setAuthSession,
                logout,
            }}
            navigation={navigation}
            globalContext={globalContext}
            runnerSelection={runnerSelection}
        />
    );
}

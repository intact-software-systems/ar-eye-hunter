import type { AuthSession } from '@shared/api/api-config.ts';
import { clearSession, writeSession } from '@shared/api/auth.ts';
import { lazy, Suspense, useEffect, useState } from 'react';
import {
    captureInitialRecipeConsoleControlCredentialPolicy,
    scrubCurrentRecipeConsoleUrlBeforeLoad
} from './app/recipe-console-url-guard.ts';
import { useExperienceRoute } from './app/use-experience-route.ts';
import { authErrorMessage, bootstrapPatchFromAuthSession } from './auth-flow.ts';
import { readAuthSessionFromRallarAuthState } from './auth-lifecycle.ts';
import {
    consumeBootstrapAgentSessionTicket,
    scrubBrowserAgentBootstrapSecretsFromUrl
} from './bootstrap-agent-session.ts';
import { loadBrowserRallarFacade } from './legacy/rallar/load-browser-rallar-facade.ts';
import { LoginScreen } from './legacy/shell/LoginScreen.tsx';
import { readCurrentAuthSession } from './legacy/shell/read-current-auth-session.ts';
import { rallarBlackBoxRuntimeStore, useRallarBlackBoxRuntimeStore } from './runtime-store.ts';

// Recipe Console work belongs under `src/recipe-console/**`; legacy extraction belongs under `src/legacy/**`; no new feature panel belongs in `App.tsx`.

const initialRecipeConsoleControlCredentialPolicy = (() => {
    const credentialPolicy = captureInitialRecipeConsoleControlCredentialPolicy();
    scrubBrowserAgentBootstrapSecretsFromUrl();
    return credentialPolicy;
})();

const RecipeConsoleApp = lazy(() => {
    scrubCurrentRecipeConsoleUrlBeforeLoad();
    return import('./recipe-console/app/RecipeConsoleApp.tsx');
});
const LegacyExperience = lazy(() => import('./legacy/shell/LegacyExperience.tsx'));

export default function App() {
    const runtime = useRallarBlackBoxRuntimeStore();
    const { bootstrap } = runtime;
    const canConsumeBootstrapAgentTicket = initialRecipeConsoleControlCredentialPolicy.allowBootstrapAgentTicket;
    const [authSession, setAuthSession] = useState<AuthSession | undefined>(
        () => bootstrap.rallarAgentSessionTicket ? undefined : readCurrentAuthSession()
    );
    const [authBusy, setAuthBusy] = useState(false);
    const [authError, setAuthError] = useState<string | undefined>();
    const experience = useExperienceRoute();
    const requiresLogin = bootstrap.providerMode === 'browser-rallar';

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
                    if (
                        bootstrap.rallarAgentSessionTicket &&
                        canConsumeBootstrapAgentTicket
                    ) {
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
    }, [
        bootstrap.apiBaseUrl,
        bootstrap.rallarAgentSessionTicket,
        canConsumeBootstrapAgentTicket,
        requiresLogin
    ]);

    useEffect(() => {
        if (requiresLogin && authSession) {
            rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                bootstrapPatchFromAuthSession(
                    authSession,
                    bootstrap.apiBaseUrl
                )
            );
        }
    }, [authSession, bootstrap.apiBaseUrl, requiresLogin]);

    useEffect(() => {
        if (
            !requiresLogin ||
            !bootstrap.rallarAgentSessionTicket ||
            !canConsumeBootstrapAgentTicket
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
                bootstrap.apiBaseUrl
            );
            if (cancelled) {
                return;
            }

            writeSession(session);
            setAuthSession(session);
            setAuthBusy(false);
            rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                {
                    ...bootstrapPatchFromAuthSession(
                        session,
                        bootstrap.apiBaseUrl
                    ),
                    rallarAgentSessionTicket: undefined
                }
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
        canConsumeBootstrapAgentTicket,
        requiresLogin
    ]);

    const logout = async (): Promise<void> => {
        setAuthBusy(true);
        setAuthError(undefined);
        try {
            const facade = await loadBrowserRallarFacade();
            facade.configure({ apiBaseUrl: bootstrap.apiBaseUrl });
            await facade.disconnect();
            await facade.auth.logout();
        }
        catch (error) {
            setAuthError(authErrorMessage(error));
        }
        finally {
            setAuthSession(readCurrentAuthSession());
            setAuthBusy(false);
        }
    };

    if (
        requiresLogin &&
        bootstrap.rallarAgentSessionTicket &&
        canConsumeBootstrapAgentTicket
    ) {
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

    const auth = {
        authSession,
        authBusy,
        authError,
        setAuthSession,
        logout
    };

    return (
        <Suspense fallback={<main className="auth-shell">Loading experience…</main>}>
            {experience === 'recipe-console'
                ? (
                    <RecipeConsoleApp
                        authSession={authSession}
                        authBusy={authBusy}
                        authError={authError}
                        controlBootstrap={{
                            controlUrl: bootstrap.controlUrl,
                            bootstrapRunId: bootstrap.runId,
                            apiBaseUrl: bootstrap.apiBaseUrl,
                            providerMode: bootstrap.providerMode,
                            manualToken: bootstrap.controlToken,
                            credentialPolicy: initialRecipeConsoleControlCredentialPolicy,
                            bootstrapGroup: {
                                applicationId: bootstrap.applicationId,
                                workspaceId: bootstrap.workspaceId,
                                groupId: bootstrap.roomId
                            }
                        }}
                        onLogout={logout}
                    />
                )
                : <LegacyExperience runtime={runtime} auth={auth} />}
        </Suspense>
    );
}

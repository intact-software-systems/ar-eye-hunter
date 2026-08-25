import type { RallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import { lazy, Suspense } from 'react';

import { LoginScreen } from '../legacy/shell/LoginScreen.tsx';
import type { RecipeConsoleControlCredentialPolicy } from '../recipe-console/control/control-credential-policy.ts';
import type { RecipeConsoleControlBootstrap } from '../recipe-console/control/ControlConnectionProvider.tsx';
import type { useRallarBlackBoxRuntimeStore } from '../runtime-store.ts';
import type { AppExperience } from './experience-route.ts';
import { scrubCurrentRecipeConsoleUrlBeforeLoad } from './recipe-console-url-guard.ts';
import type { AppAuthState } from './use-app-auth-state.ts';

const RecipeConsoleApp = lazy(() => {
    scrubCurrentRecipeConsoleUrlBeforeLoad();
    return import('../recipe-console/app/RecipeConsoleApp.tsx');
});
const WorkbenchExperience = lazy(() => import('../workbench/workbench-experience.tsx'));

interface AppExperienceRouterProps {
    readonly runtime: ReturnType<typeof useRallarBlackBoxRuntimeStore>;
    readonly auth: AppAuthState;
    readonly experience: AppExperience;
    readonly credentialPolicy: RecipeConsoleControlCredentialPolicy;
}

interface ConnectingAgentSessionProps {
    readonly authBusy: boolean;
    readonly authError?: string;
}

export function AppExperienceRouter({
    runtime,
    auth,
    experience,
    credentialPolicy
}: AppExperienceRouterProps) {
    const { bootstrap } = runtime;
    const requiresLogin = bootstrap.providerMode === 'browser-rallar';
    if (
        requiresLogin &&
        bootstrap.rallarAgentSessionTicket &&
        credentialPolicy.allowBootstrapAgentTicket
    ) {
        return <ConnectingAgentSession authBusy={auth.authBusy} authError={auth.authError} />;
    }
    if (requiresLogin && !auth.authSession) {
        return <LoginScreenBoundary bootstrap={bootstrap} auth={auth} />;
    }

    return (
        <Suspense fallback={<main className="auth-shell">Loading experience…</main>}>
            {experience === 'recipe-console'
                ? (
                    <RecipeConsoleApp
                        authSession={auth.authSession}
                        authBusy={auth.authBusy}
                        authError={auth.authError}
                        controlBootstrap={toRecipeConsoleBootstrap(bootstrap, credentialPolicy)}
                        onLogout={auth.logout}
                    />
                )
                : <WorkbenchExperience runtime={runtime} auth={auth} />}
        </Suspense>
    );
}

function ConnectingAgentSession({ authBusy, authError }: ConnectingAgentSessionProps) {
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
                        Consuming one-time agent ticket…
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

interface LoginScreenBoundaryProps {
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly auth: AppAuthState;
}

function LoginScreenBoundary({ bootstrap, auth }: LoginScreenBoundaryProps) {
    return (
        <LoginScreen
            bootstrap={bootstrap}
            onAuthenticated={auth.acceptLoginSession}
        />
    );
}

function toRecipeConsoleBootstrap(
    bootstrap: RallarBlackBoxBootstrapConfig,
    credentialPolicy: RecipeConsoleControlCredentialPolicy
): RecipeConsoleControlBootstrap {
    return {
        controlUrl: bootstrap.controlUrl,
        bootstrapRunId: bootstrap.runId,
        apiBaseUrl: bootstrap.apiBaseUrl,
        providerMode: bootstrap.providerMode,
        manualToken: bootstrap.controlToken,
        credentialPolicy,
        bootstrapGroup: {
            applicationId: bootstrap.applicationId,
            workspaceId: bootstrap.workspaceId,
            groupId: bootstrap.roomId
        }
    };
}

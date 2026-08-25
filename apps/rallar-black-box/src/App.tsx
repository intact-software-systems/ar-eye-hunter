import { AppExperienceRouter } from './app/app-experience-router.tsx';
import { captureInitialRecipeConsoleControlCredentialPolicy } from './app/recipe-console-url-guard.ts';
import { useAppAuthState } from './app/use-app-auth-state.ts';
import { useExperienceRoute } from './app/use-experience-route.ts';
import { scrubBrowserAgentBootstrapSecretsFromUrl } from './bootstrap-agent-session.ts';
import { useRallarBlackBoxRuntimeStore } from './runtime-store.ts';

const initialRecipeConsoleControlCredentialPolicy = (() => {
    const credentialPolicy = captureInitialRecipeConsoleControlCredentialPolicy();
    scrubBrowserAgentBootstrapSecretsFromUrl();
    return credentialPolicy;
})();

export default function App() {
    const runtime = useRallarBlackBoxRuntimeStore();
    const experience = useExperienceRoute();
    const auth = useAppAuthState({
        bootstrap: runtime.bootstrap,
        canConsumeBootstrapAgentTicket: initialRecipeConsoleControlCredentialPolicy.allowBootstrapAgentTicket
    });

    return (
        <AppExperienceRouter
            runtime={runtime}
            auth={auth}
            experience={experience}
            credentialPolicy={initialRecipeConsoleControlCredentialPolicy}
        />
    );
}

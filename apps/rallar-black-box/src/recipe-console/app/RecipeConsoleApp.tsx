import type { AuthSession } from '@shared/api/api-config.ts';
import '../design/tokens.css';
import '../design/reset.css';
import { ControlConnectionProvider } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleControlBootstrap } from '../control/ControlConnectionProvider.tsx';
import { RecipeConsolePreferencesController } from './RecipeConsolePreferencesController.tsx';
import { RecipeConsoleWorkspace } from './RecipeConsoleWorkspace.tsx';

export type RecipeConsoleAppProps = Readonly<{
    authSession?: AuthSession;
    authBusy: boolean;
    authError?: string;
    controlBootstrap: RecipeConsoleControlBootstrap;
    onLogout(): Promise<void>;
}>;

export default function RecipeConsoleApp({
    authSession,
    authBusy,
    authError,
    controlBootstrap,
    onLogout
}: RecipeConsoleAppProps) {
    return (
        <RecipeConsolePreferencesController
            bootstrap={controlBootstrap}
        >
            {(preferences) => (
                <ControlConnectionProvider
                    authSession={authSession}
                    bootstrap={preferences.state.effectiveBootstrap}
                    controlReadTimeoutMs={preferences.state.controlReadTimeoutMs}
                >
                    <RecipeConsoleWorkspace
                        accountSettings={{
                            authBusy,
                            authError,
                            authSession,
                            onLogout,
                            preferences
                        }}
                    />
                </ControlConnectionProvider>
            )}
        </RecipeConsolePreferencesController>
    );
}

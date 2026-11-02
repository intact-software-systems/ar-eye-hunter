import type { AuthSession } from '@shared/api/api-config.ts';
import '../design/tokens.css';
import '../design/reset.css';
import { ControlConnectionProvider } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleControlBootstrap } from '../control/ControlConnectionProvider.tsx';
import { RoomOperationsProvider } from '../rooms/room-operations-provider.tsx';
import { RecipeConsoleWorkspace } from './recipe-console-workspace.tsx';
import { RecipeConsolePreferencesController } from './RecipeConsolePreferencesController.tsx';

export interface RecipeConsoleAppProps {
    readonly authSession?: AuthSession;
    readonly authBusy: boolean;
    readonly authError?: string;
    readonly controlBootstrap: RecipeConsoleControlBootstrap;
    onLogout(): Promise<void>;
}

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
                    <RoomOperationsProvider
                        apiBaseUrl={preferences.state.effectiveBootstrap.apiBaseUrl}
                        endpointFromLocation={preferences.state.effectiveBootstrap.credentialPolicy
                            .apiBaseUrlFromLocation}
                        session={authSession ?? null}
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
                    </RoomOperationsProvider>
                </ControlConnectionProvider>
            )}
        </RecipeConsolePreferencesController>
    );
}

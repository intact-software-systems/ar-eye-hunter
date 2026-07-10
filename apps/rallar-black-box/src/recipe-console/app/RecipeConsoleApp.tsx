import type { AuthSession } from '@shared/api/api-config.ts';
import '../design/tokens.css';
import '../design/reset.css';
import { ControlConnectionProvider } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleControlBootstrap } from '../control/ControlConnectionProvider.tsx';
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
    controlBootstrap,
}: RecipeConsoleAppProps) {
    return (
        <ControlConnectionProvider
            authSession={authSession}
            bootstrap={controlBootstrap}
        >
            <RecipeConsoleWorkspace />
        </ControlConnectionProvider>
    );
}

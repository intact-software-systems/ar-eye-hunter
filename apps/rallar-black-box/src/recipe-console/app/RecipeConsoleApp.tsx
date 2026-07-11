import type { AuthSession } from '@shared/api/api-config.ts';

export type RecipeConsoleAppProps = Readonly<{
    authSession?: AuthSession;
    authBusy: boolean;
    authError?: string;
    onLogout(): Promise<void>;
}>;

export default function RecipeConsoleApp(
    _props: RecipeConsoleAppProps,
) {
    return (
        <main className="recipe-console" data-view="execute">
            <h1>Recipe Console</h1>
            <p>Preparing the Execute workspace.</p>
        </main>
    );
}

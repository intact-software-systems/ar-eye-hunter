import type { AuthSession } from '@shared/api/api-config.ts';
import { useState } from 'react';
import '../design/tokens.css';
import '../design/reset.css';
import { RecipeConsoleWorkspace } from './RecipeConsoleWorkspace.tsx';

export type RecipeConsoleAppProps = Readonly<{
    authSession?: AuthSession;
    authBusy: boolean;
    authError?: string;
    onLogout(): Promise<void>;
}>;

export default function RecipeConsoleApp({ authBusy }: RecipeConsoleAppProps) {
    const [revision, setRevision] = useState<0 | 1>(0);
    return (
        <RecipeConsoleWorkspace
            authBusy={authBusy}
            key={revision}
            onRefresh={() => setRevision(value => value === 0 ? 1 : 0)}
        />
    );
}

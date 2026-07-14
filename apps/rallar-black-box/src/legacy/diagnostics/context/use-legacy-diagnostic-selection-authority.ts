import { useState } from 'react';

type DiagnosticSelectionAuthorityState = Readonly<{
    active: boolean;
    issue?: string;
}>;

export type LegacyDiagnosticSelectionAuthority = Readonly<{
    active: boolean;
    issue?: string;
    reportIssue: (issue: string) => void;
    acceptManualSelection: () => void;
    finishInitialSelection: () => void;
}>;

export function useLegacyDiagnosticSelectionAuthority(
    requested: boolean,
): LegacyDiagnosticSelectionAuthority {
    const [state, setState] = useState<DiagnosticSelectionAuthorityState>({
        active: requested,
    });

    const finish = (): void => {
        setState(current => current.active || current.issue
            ? { active: false }
            : current);
    };

    return {
        active: state.active,
        issue: state.issue,
        reportIssue: (issue) => {
            setState(current =>
                current.active && current.issue === issue
                    ? current
                    : { active: true, issue });
        },
        acceptManualSelection: finish,
        finishInitialSelection: finish,
    };
}

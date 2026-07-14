import type { Dispatch, SetStateAction } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { useRallarBlackBoxRuntimeStore } from '../../runtime-store.ts';
import type { useRunnerShellState } from '../runner/shell/use-runner-shell-state.ts';
import type { useCommandCenterGlobalContext } from './use-command-center-global-context.ts';
import type { useLegacyNavigation } from './use-legacy-navigation.ts';
import type { ParsedLegacyDiagnosticContext } from
    '../diagnostics/context/legacy-diagnostic-context.ts';

export type LegacyShellRuntime = ReturnType<
    typeof useRallarBlackBoxRuntimeStore
>;

export type LegacyShellAuth = Readonly<{
    authSession?: AuthSession;
    authBusy: boolean;
    authError?: string;
    setAuthSession: Dispatch<SetStateAction<AuthSession | undefined>>;
    logout(): Promise<void>;
}>;

export type LegacyShellNavigation = ReturnType<typeof useLegacyNavigation>;

export type LegacyShellGlobalContext = ReturnType<
    typeof useCommandCenterGlobalContext
>;

export type LegacyShellRunnerSelection = ReturnType<
    typeof useRunnerShellState
>;

export type LegacyShellDiagnosticContext = ParsedLegacyDiagnosticContext;

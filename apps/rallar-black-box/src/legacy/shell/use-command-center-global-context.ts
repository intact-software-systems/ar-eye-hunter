import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import {
    rallarBlackBoxRuntimeStore,
    type RallarBlackBoxBootstrapConfig,
} from '../../runtime-store.ts';
import {
    bootstrapPatchFromGlobalValues,
    commandCenterGlobalValuesFromState,
    reconcileDiagnosticGlobalScope,
    sameCommandCenterGlobalValues,
    type CommandCenterGlobalValues,
} from './global-context-model.ts';
import { deriveRallarBrowserStatus } from './rallar-browser-status.ts';
import type { LegacyDiagnosticContext } from
    '../diagnostics/context/legacy-diagnostic-context.ts';

export function useCommandCenterGlobalContext({
    state,
    bootstrap,
    authSession,
    diagnosticContext,
}: Readonly<{
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    diagnosticContext?: LegacyDiagnosticContext;
}>) {
    const defaultGlobalValues = useMemo(
        () => commandCenterGlobalValuesFromState(
            state,
            bootstrap,
            authSession,
            diagnosticContext,
        ),
        [
            authSession?.clientId,
            authSession?.sessionId,
            authSession?.username,
            bootstrap.actor,
            bootstrap.apiBaseUrl,
            bootstrap.roomId,
            bootstrap.sessionId,
            diagnosticContext?.contextApplicationId,
            diagnosticContext?.contextGroupId,
            diagnosticContext?.contextWorkspaceId,
            state.currentConfig,
        ],
    );
    const [globalValues, setGlobalValues] =
        useState<CommandCenterGlobalValues>(defaultGlobalValues);
    const [globalValuesEdited, setGlobalValuesEdited] = useState(false);
    const browserStatus = useMemo(
        () => deriveRallarBrowserStatus(state, globalValues),
        [globalValues, state],
    );
    const lastGlobalAuthKey = useRef<string | undefined>(
        authSession
            ? `${authSession.clientId ?? authSession.username}:${authSession.sessionId}`
            : undefined,
    );
    const diagnosticContextKey = JSON.stringify([
        diagnosticContext?.contextApplicationId,
        diagnosticContext?.contextWorkspaceId,
        diagnosticContext?.contextGroupId,
    ]);
    const lastDiagnosticContextKey = useRef(diagnosticContextKey);

    useEffect(() => {
        const authKey = authSession
            ? `${authSession.clientId ?? authSession.username}:${authSession.sessionId}`
            : undefined;
        const authChanged = authKey !== lastGlobalAuthKey.current;
        lastGlobalAuthKey.current = authKey;
        const diagnosticContextChanged =
            diagnosticContextKey !== lastDiagnosticContextKey.current;
        lastDiagnosticContextKey.current = diagnosticContextKey;

        setGlobalValues((current) => {
            if (!globalValuesEdited) {
                return sameCommandCenterGlobalValues(
                    current,
                    defaultGlobalValues,
                )
                    ? current
                    : defaultGlobalValues;
            }

            const nextValues = {
                ...current,
                apiBaseUrl:
                    current.apiBaseUrl || defaultGlobalValues.apiBaseUrl,
                applicationId:
                    current.applicationId || defaultGlobalValues.applicationId,
                workspaceId:
                    current.workspaceId || defaultGlobalValues.workspaceId,
                roomId: current.roomId || defaultGlobalValues.roomId,
                clientId:
                    authChanged && authSession
                        ? (authSession.clientId ?? authSession.username)
                        : current.clientId || defaultGlobalValues.clientId,
                sessionId:
                    authChanged && authSession
                        ? authSession.sessionId
                        : current.sessionId || defaultGlobalValues.sessionId,
            };

            const reconciledValues = reconcileDiagnosticGlobalScope(
                nextValues,
                defaultGlobalValues,
                diagnosticContextChanged,
            );

            return sameCommandCenterGlobalValues(current, reconciledValues)
                ? current
                : reconciledValues;
        });
    }, [
        authSession?.clientId,
        authSession?.sessionId,
        authSession?.username,
        defaultGlobalValues,
        diagnosticContextKey,
        globalValuesEdited,
    ]);

    const updateGlobalValue = <K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void => {
        const nextValues = {
            ...globalValues,
            [key]: value,
        };
        setGlobalValues(nextValues);
        setGlobalValuesEdited(true);
        rallarBlackBoxRuntimeStore.updateBootstrapConfig(
            bootstrapPatchFromGlobalValues(nextValues),
        );
    };
    const resetGlobalValues = (): void => {
        setGlobalValues(defaultGlobalValues);
        setGlobalValuesEdited(false);
        rallarBlackBoxRuntimeStore.updateBootstrapConfig(
            bootstrapPatchFromGlobalValues(defaultGlobalValues),
        );
    };

    return {
        globalValues,
        globalValuesEdited,
        browserStatus,
        updateGlobalValue,
        resetGlobalValues,
    };
}

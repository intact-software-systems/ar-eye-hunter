import {
    decodeRallarBlackBoxConfigProviderMode,
    type RallarBlackBoxProviderMode
} from '@shared-test/rallar-bb-test/client-defaults.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { getRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/test-state-accessors.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import type { AuthCommandCenterTicket } from '../shared/auth-command-center-ticket.ts';
import type { CommandCenterRestActionLog } from '../shared/to-rest-action-log-entry.ts';
import { AuthCommandCenterActions } from './auth-command-center-actions.ts';
import type {
    AuthCommandCenterDraft,
    AuthCommandCenterModel,
    AuthCommandCenterOperations,
    AuthCommandCenterPanelProps
} from './auth-command-center-contracts.ts';
import { toAuthCommandCenterRecipeText } from './to-auth-command-center-recipe-text.ts';

interface AuthCommandCenterControls {
    /** Absent while no auth action runs. */
    readonly busyAction: string | undefined;
    readonly setBusyAction: React.Dispatch<React.SetStateAction<string | undefined>>;
    /** Absent when the last auth action succeeded. */
    readonly localError: string | undefined;
    readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
    /** Absent until a WS ticket is created, and again once the local session is cleared. */
    readonly ticket: AuthCommandCenterTicket | undefined;
    readonly setTicket: React.Dispatch<React.SetStateAction<AuthCommandCenterTicket | undefined>>;
    readonly actions: readonly CommandCenterRestActionLog[];
    readonly setActions: React.Dispatch<React.SetStateAction<readonly CommandCenterRestActionLog[]>>;
}

interface AuthCommandCenterDiagnostics {
    readonly state: RallarBlackBoxTestState;
    /** Absent while the browser is signed out. */
    readonly authSession: AuthSession | undefined;
    readonly providerMode: RallarBlackBoxProviderMode;
    readonly apiBaseUrl: string;
    /** Absent while no WS ticket is held. */
    readonly ticket: AuthCommandCenterTicket | undefined;
    readonly actions: readonly CommandCenterRestActionLog[];
}

interface AuthCommandCenterTexts {
    readonly diagnosticsText: string;
    readonly recipeText: string;
}

export function useAuthCommandCenterController(props: AuthCommandCenterPanelProps): AuthCommandCenterModel {
    const { state, authSession } = props;
    const providerMode = decodeRallarBlackBoxConfigProviderMode(getRallarBlackBoxCurrentConfig(state))
        .fold(() => props.bootstrap.providerMode, (mode) => mode);
    const draft = useAuthCommandCenterDraft(props);
    const controls = useAuthCommandCenterControls();
    const { ticket, actions } = controls;
    const diagnostics = { state, authSession, providerMode, apiBaseUrl: draft.apiBaseUrl, ticket, actions };
    const texts = useAuthCommandCenterTexts(diagnostics, draft.username);
    const operations = new AuthCommandCenterActions({
        ...draft,
        ...controls,
        ...texts,
        authSession,
        onAuthenticated: props.onAuthenticated,
        nowMs: Date.now
    });
    const nowMs = Date.now();
    return {
        ...draft,
        ...toAuthCommandCenterOperations(operations),
        providerMode,
        busyAction: controls.busyAction,
        localError: controls.localError,
        ticket,
        actions,
        sessionExpiresInMs: authSession ? authSession.expiresAtEpochMs - nowMs : undefined,
        wsTicketExpiresInMs: ticket ? ticket.expiresAtEpochMs - nowMs : undefined
    };
}

function useAuthCommandCenterTexts(
    diagnostics: AuthCommandCenterDiagnostics,
    username: string
): AuthCommandCenterTexts {
    const { actions, apiBaseUrl, authSession, providerMode, state, ticket } = diagnostics;
    const recipeText = useMemo(
        () => toAuthCommandCenterRecipeText({ username, createRequestId: () => crypto.randomUUID() }),
        [username]
    );
    const diagnosticsText = useMemo(
        () =>
            toAuthCommandCenterDiagnosticsText(
                { actions, apiBaseUrl, authSession, providerMode, state, ticket },
                Date.now()
            ),
        [actions, apiBaseUrl, authSession, providerMode, state, ticket]
    );
    return { diagnosticsText, recipeText };
}

function toAuthCommandCenterOperations(operations: AuthCommandCenterActions): AuthCommandCenterOperations {
    return {
        login: operations.login,
        registerAndLogin: operations.registerAndLogin,
        restore: operations.restore,
        clearLocal: operations.clearLocal,
        createWsTicket: operations.createWsTicket,
        negativeWsTicket: operations.negativeWsTicket,
        expiredWsTicket: operations.expiredWsTicket,
        negativeLogin: operations.negativeLogin,
        copyDiagnostics: operations.copyDiagnostics,
        copyRecipe: operations.copyRecipe
    };
}

function useAuthCommandCenterDraft(
    { bootstrap, authSession, globalValues }: AuthCommandCenterPanelProps
): AuthCommandCenterDraft {
    const [apiBaseUrl, setApiBaseUrl] = useState(globalValues.apiBaseUrl);
    const [username, setUsername] = useState(authSession?.username ?? bootstrap.rallarUsername ?? bootstrap.actor);
    const [password, setPassword] = useState(bootstrap.rallarPassword ?? '');
    useEffect(() => {
        if (globalValues.apiBaseUrl) {
            setApiBaseUrl(globalValues.apiBaseUrl);
        }
    }, [globalValues.apiBaseUrl]);
    return { apiBaseUrl, setApiBaseUrl, username, setUsername, password, setPassword };
}

function useAuthCommandCenterControls(): AuthCommandCenterControls {
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [ticket, setTicket] = useState<AuthCommandCenterTicket | undefined>();
    const [actions, setActions] = useState<readonly CommandCenterRestActionLog[]>([]);
    return { busyAction, setBusyAction, localError, setLocalError, ticket, setTicket, actions, setActions };
}

function toAuthCommandCenterDiagnosticsText(diagnostics: AuthCommandCenterDiagnostics, nowMs: number): string {
    const { ticket, authSession } = diagnostics;
    return redactedJson(
        {
            providerMode: diagnostics.providerMode,
            apiBaseUrl: diagnostics.apiBaseUrl,
            session: authSession,
            wsTicket: ticket
                ? {
                    ...ticket,
                    ticket: '<redacted:ws-ticket>',
                    expiresInMs: ticket.expiresAtEpochMs - nowMs
                }
                : undefined,
            recentActions: diagnostics.actions.slice(-6)
        },
        diagnostics.state,
        authSession
    );
}

import type { RallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type { RallarAuthState } from '@shared-web/browser/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { clearSession, writeSession } from '@shared/api/auth.ts';
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import { authErrorMessage, bootstrapPatchFromAuthSession } from '../auth-flow.ts';
import { readAuthSessionFromRallarAuthState } from '../auth-lifecycle.ts';
import { consumeBootstrapAgentSessionTicket } from '../bootstrap-agent-session.ts';
import { loadBrowserRallarFacade } from '../legacy/rallar/load-browser-rallar-facade.ts';
import { readCurrentAuthSession } from '../legacy/shell/read-current-auth-session.ts';
import { rallarBlackBoxRuntimeStore } from '../runtime-store.ts';

export interface AppAuthState {
    readonly authSession?: AuthSession;
    readonly authBusy: boolean;
    readonly authError?: string;
    readonly setAuthSession: Dispatch<SetStateAction<AuthSession | undefined>>;
    readonly acceptLoginSession: (session: AuthSession) => void;
    readonly logout: () => Promise<void>;
}

interface UseAppAuthStateInput {
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly canConsumeBootstrapAgentTicket: boolean;
}

interface BrowserAuthSubscriptionInput extends UseAppAuthStateInput {
    readonly requiresLogin: boolean;
    readonly setAuthSession: Dispatch<SetStateAction<AuthSession | undefined>>;
    readonly setAuthBusy: Dispatch<SetStateAction<boolean>>;
}

interface BootstrapAgentTicketInput extends BrowserAuthSubscriptionInput {
    readonly setAuthError: Dispatch<SetStateAction<string | undefined>>;
}

function useBrowserAuthSubscription(input: BrowserAuthSubscriptionInput): void {
    useEffect(() => {
        if (!input.requiresLogin) {
            return;
        }

        let cancelled = false;
        let unsubscribe: (() => void) | undefined;
        const acceptAuthState = (state: RallarAuthState): void => {
            if (
                input.bootstrap.rallarAgentSessionTicket &&
                input.canConsumeBootstrapAgentTicket
            ) {
                return;
            }
            const nextSession = readAuthSessionFromRallarAuthState(state);
            input.setAuthSession(nextSession);
            if (!nextSession) {
                input.setAuthBusy(false);
            }
        };
        void loadBrowserRallarFacade()
            .then((facade) => {
                if (cancelled) {
                    return;
                }
                facade.configure({ apiBaseUrl: input.bootstrap.apiBaseUrl });
                unsubscribe = facade.auth.onChange(acceptAuthState, { emitCurrent: true });
            })
            .catch(() => {
                // Connect-time diagnostics surface configuration conflicts.
            });

        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, [
        input.bootstrap.apiBaseUrl,
        input.bootstrap.rallarAgentSessionTicket,
        input.canConsumeBootstrapAgentTicket,
        input.requiresLogin,
        input.setAuthBusy,
        input.setAuthSession
    ]);
}

function useBootstrapAgentTicket(input: BootstrapAgentTicketInput): void {
    useEffect(() => {
        if (
            !input.requiresLogin ||
            !input.bootstrap.rallarAgentSessionTicket ||
            !input.canConsumeBootstrapAgentTicket
        ) {
            return;
        }

        let cancelled = false;
        input.setAuthBusy(true);
        input.setAuthError(undefined);
        void consumeAgentTicket(input)
            .then((session) => {
                if (!cancelled) {
                    acceptAgentTicket(session, input);
                }
            })
            .catch((error) => {
                if (!cancelled) {
                    input.setAuthError(authErrorMessage(error));
                }
            })
            .finally(() => {
                if (!cancelled) {
                    input.setAuthBusy(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [
        input.bootstrap.apiBaseUrl,
        input.bootstrap.rallarAgentSessionTicket,
        input.canConsumeBootstrapAgentTicket,
        input.requiresLogin,
        input.setAuthBusy,
        input.setAuthError,
        input.setAuthSession
    ]);
}

async function consumeAgentTicket(input: BootstrapAgentTicketInput): Promise<AuthSession> {
    const facade = await loadBrowserRallarFacade();
    facade.configure({ apiBaseUrl: input.bootstrap.apiBaseUrl });
    clearSession();
    return consumeBootstrapAgentSessionTicket(
        input.bootstrap.rallarAgentSessionTicket ?? '',
        input.bootstrap.apiBaseUrl
    );
}

function acceptAgentTicket(session: AuthSession, input: BootstrapAgentTicketInput): void {
    writeSession(session);
    input.setAuthSession(session);
    input.setAuthBusy(false);
    rallarBlackBoxRuntimeStore.updateBootstrapConfig({
        ...bootstrapPatchFromAuthSession(session, input.bootstrap.apiBaseUrl),
        rallarAgentSessionTicket: undefined
    });
}

export function useAppAuthState(input: UseAppAuthStateInput): AppAuthState {
    const requiresLogin = input.bootstrap.providerMode === 'browser-rallar';
    const [authSession, setAuthSession] = useState<AuthSession | undefined>(
        () => input.bootstrap.rallarAgentSessionTicket ? undefined : readCurrentAuthSession()
    );
    const [authBusy, setAuthBusy] = useState(false);
    const [authError, setAuthError] = useState<string | undefined>();
    const lifecycleInput: BootstrapAgentTicketInput = {
        ...input,
        requiresLogin,
        setAuthSession,
        setAuthBusy,
        setAuthError
    };

    useBrowserAuthSubscription(lifecycleInput);
    useBootstrapConfigSync(input.bootstrap, requiresLogin, authSession);
    useBootstrapAgentTicket(lifecycleInput);

    const logout = useCallback(async (): Promise<void> => {
        setAuthBusy(true);
        setAuthError(undefined);
        try {
            const facade = await loadBrowserRallarFacade();
            facade.configure({ apiBaseUrl: input.bootstrap.apiBaseUrl });
            await facade.disconnect();
            await facade.auth.logout();
        }
        catch (error) {
            setAuthError(authErrorMessage(error));
        }
        finally {
            setAuthSession(readCurrentAuthSession());
            setAuthBusy(false);
        }
    }, [input.bootstrap.apiBaseUrl]);
    const acceptLoginSession = useCallback((session: AuthSession): void => {
        setAuthError(undefined);
        setAuthSession(session);
    }, []);

    return {
        authSession,
        authBusy,
        authError,
        setAuthSession,
        acceptLoginSession,
        logout
    };
}

function useBootstrapConfigSync(
    bootstrap: RallarBlackBoxBootstrapConfig,
    requiresLogin: boolean,
    authSession: AuthSession | undefined
): void {
    useEffect(() => {
        if (requiresLogin && authSession) {
            rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                bootstrapPatchFromAuthSession(authSession, bootstrap.apiBaseUrl)
            );
        }
    }, [authSession, bootstrap.apiBaseUrl, requiresLogin]);
}

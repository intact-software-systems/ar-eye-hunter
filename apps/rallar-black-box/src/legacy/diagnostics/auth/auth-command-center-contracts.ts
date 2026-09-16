import type { RallarBlackBoxProviderMode } from '@shared-test/rallar-bb-test/client-defaults.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import type { AuthCommandCenterTicket } from '../shared/auth-command-center-ticket.ts';
import type { CommandCenterRestActionLog } from '../shared/to-rest-action-log-entry.ts';

export interface AuthCommandCenterPanelProps {
    readonly state: RallarBlackBoxTestState;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    /** Absent until the browser signs in. */
    readonly authSession?: AuthSession;
    /** Absent when the panel renders outside the command-center shell. */
    readonly globalValues?: CommandCenterGlobalValues;
    /** Receives undefined when the local session is cleared or no stored session can be restored. */
    onAuthenticated(session: AuthSession | undefined): void;
    onLogout(): Promise<void>;
}

export interface AuthCommandCenterDraft {
    readonly apiBaseUrl: string;
    setApiBaseUrl(value: string): void;
    readonly username: string;
    setUsername(value: string): void;
    readonly password: string;
    setPassword(value: string): void;
}

export interface AuthCommandCenterActivity {
    readonly providerMode: RallarBlackBoxProviderMode;
    /** Absent while no auth action runs. */
    readonly busyAction: string | undefined;
    /** Absent when the last auth action succeeded. */
    readonly localError: string | undefined;
    /** Absent until a WS ticket is created, and again once the local session is cleared. */
    readonly ticket: AuthCommandCenterTicket | undefined;
    readonly actions: readonly CommandCenterRestActionLog[];
    /** Absent while the browser is signed out. */
    readonly sessionExpiresInMs: number | undefined;
    /** Absent while no WS ticket is held. */
    readonly wsTicketExpiresInMs: number | undefined;
}

export interface AuthCommandCenterOperations {
    login(): Promise<void>;
    registerAndLogin(): Promise<void>;
    restore(): void;
    clearLocal(): void;
    createWsTicket(): Promise<void>;
    negativeWsTicket(): Promise<void>;
    expiredWsTicket(): Promise<void>;
    negativeLogin(): Promise<void>;
    copyDiagnostics(): void;
    copyRecipe(): void;
}

export interface AuthCommandCenterModel
    extends AuthCommandCenterDraft, AuthCommandCenterActivity, AuthCommandCenterOperations {}

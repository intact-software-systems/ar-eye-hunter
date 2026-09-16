import type { AuthSession } from '@shared/api/api-config.ts';
import { clearSession } from '@shared/api/auth.ts';
import { Either } from '@shared/resilience/Either.ts';
import type * as React from 'react';
import { authenticateRallarBlackBox, authErrorMessage, bootstrapPatchFromAuthSession } from '../../../auth-flow.ts';
import type {
    RallarServerRestRequestInput,
    RallarServerRestResponse
} from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import { sendRallarServerMutationRequest } from '../../../rallar-server-workbench/send-rallar-server-rest-request.ts';
import { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { recordValue } from '../../shared/record-value.ts';
import { writeTextToClipboard } from '../../shared/write-text-to-clipboard.ts';
import { readCurrentAuthSession } from '../../shell/read-current-auth-session.ts';
import type { AuthCommandCenterTicket } from '../shared/auth-command-center-ticket.ts';
import { toRestActionLogEntry, type CommandCenterRestActionLog } from '../shared/to-rest-action-log-entry.ts';
import type { AuthCommandCenterOperations } from './auth-command-center-contracts.ts';

export namespace AuthCommandCenterActions {
    export interface Input {
        /** Absent until the browser signs in; the authenticated probes then go without a bearer token. */
        readonly authSession: AuthSession | undefined;
        readonly apiBaseUrl: string;
        readonly username: string;
        readonly password: string;
        readonly diagnosticsText: string;
        readonly recipeText: string;
        readonly setBusyAction: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly setTicket: React.Dispatch<React.SetStateAction<AuthCommandCenterTicket | undefined>>;
        readonly setActions: React.Dispatch<React.SetStateAction<readonly CommandCenterRestActionLog[]>>;
        onAuthenticated(session: AuthSession | undefined): void;
        nowMs(): number;
    }

    export interface LoginAttempt {
        readonly label: string;
        readonly register: boolean;
        readonly status: number;
    }

    export interface Probe {
        readonly label: string;
        readonly path: string;
        readonly bodyText: string;
        readonly attachAuth: boolean;
        /** Absent for the probes that deliberately send no session. */
        readonly authSession: AuthSession | undefined;
    }
}

const ACTION_LOG_LIMIT = 12;
const WS_TICKET_PATH = '/api/auth/ws-ticket';

export class AuthCommandCenterActions implements AuthCommandCenterOperations {
    private readonly input: AuthCommandCenterActions.Input;

    constructor(input: AuthCommandCenterActions.Input) {
        this.input = input;
    }

    readonly login = (): Promise<void> => this.authenticate({ label: 'Login', register: false, status: 200 });

    readonly registerAndLogin = (): Promise<void> =>
        this.authenticate({ label: 'Register and login', register: true, status: 201 });

    readonly restore = (): void => {
        const restored = readCurrentAuthSession();
        this.input.onAuthenticated(restored);
        if (!restored) {
            this.input.setLocalError('No restorable browser auth session was found.');
            return;
        }
        rallarBlackBoxRuntimeStore.updateBootstrapConfig(
            bootstrapPatchFromAuthSession(restored, this.input.apiBaseUrl)
        );
        const atEpochMs = this.input.nowMs();
        this.appendAction({
            actionId: `auth-restore-${atEpochMs}`,
            label: 'Restore session',
            atEpochMs,
            ok: true,
            status: 200,
            statusText: 'Restored',
            durationMs: 0,
            bodyJson: restored
        });
    };

    readonly clearLocal = (): void => {
        clearSession();
        this.input.setTicket(undefined);
        this.input.onAuthenticated(undefined);
        const atEpochMs = this.input.nowMs();
        this.appendAction({
            actionId: `auth-clear-${atEpochMs}`,
            label: 'Clear local session',
            atEpochMs,
            ok: true,
            status: 200,
            statusText: 'Cleared',
            durationMs: 0
        });
    };

    readonly createWsTicket = (): Promise<void> => {
        const label = 'Create WS ticket';
        const probe = {
            label,
            path: WS_TICKET_PATH,
            bodyText: '{}',
            attachAuth: true,
            authSession: this.input.authSession
        };
        return this.sendProbe(probe, (response) => {
            this.appendAction(toRestActionLogEntry(label, response, this.input.nowMs()));
            toCreatedTicket(response, this.input.nowMs()).foldRight(this.input.setTicket);
        });
    };

    readonly negativeWsTicket = (): Promise<void> =>
        this.sendLoggedProbe({
            label: 'Missing auth WS ticket',
            path: WS_TICKET_PATH,
            bodyText: '{}',
            attachAuth: false,
            authSession: undefined
        });

    readonly expiredWsTicket = (): Promise<void> => {
        const { authSession } = this.input;
        const expiredSession = authSession
            ? { ...authSession, expiresAtEpochMs: this.input.nowMs() - 1_000 }
            : undefined;
        return this.sendLoggedProbe({
            label: 'Expired auth WS ticket',
            path: WS_TICKET_PATH,
            bodyText: '{}',
            attachAuth: true,
            authSession: expiredSession
        });
    };

    readonly negativeLogin = (): Promise<void> => {
        const { username, password } = this.input;
        return this.sendLoggedProbe({
            label: 'Bad credentials',
            path: '/api/auth/login',
            bodyText: JSON.stringify({ username: username || 'unknown', password: `${password || 'bad'}-invalid` }),
            attachAuth: false,
            authSession: undefined
        });
    };

    readonly copyDiagnostics = (): Promise<void> => this.copyText(this.input.diagnosticsText);

    readonly copyRecipe = (): Promise<void> => this.copyText(this.input.recipeText);

    private async authenticate(attempt: AuthCommandCenterActions.LoginAttempt): Promise<void> {
        await this.runWithBusy(attempt.label, async () => {
            const { apiBaseUrl, username, password } = this.input;
            const facade = await loadBrowserRallarFacade();
            const session = await authenticateRallarBlackBox(facade, {
                apiBaseUrl,
                username,
                password,
                register: attempt.register
            });
            rallarBlackBoxRuntimeStore.updateBootstrapConfig(bootstrapPatchFromAuthSession(session, apiBaseUrl));
            this.input.onAuthenticated(session);
            const atEpochMs = this.input.nowMs();
            this.appendAction({
                actionId: `auth-${attempt.register ? 'register-login' : 'login'}-${atEpochMs}`,
                label: attempt.label,
                atEpochMs,
                ok: true,
                status: attempt.status,
                statusText: 'OK',
                durationMs: 0,
                bodyJson: session
            });
        });
    }

    private sendLoggedProbe(probe: AuthCommandCenterActions.Probe): Promise<void> {
        return this.sendProbe(probe, (response) => {
            this.appendAction(toRestActionLogEntry(probe.label, response, this.input.nowMs()));
        });
    }

    private async sendProbe(
        probe: AuthCommandCenterActions.Probe,
        recordResponse: (response: RallarServerRestResponse) => void
    ): Promise<void> {
        const requestId = crypto.randomUUID();
        await this.runWithBusy(probe.label, async () => {
            const request = toAuthProbeRequest(this.input.apiBaseUrl, probe);
            const sent = await sendRallarServerMutationRequest({ request, requestId, fetch });
            sent.fold(this.input.setLocalError, recordResponse);
        });
    }

    private async runWithBusy(label: string, action: () => Promise<void>): Promise<void> {
        this.input.setBusyAction(label);
        this.input.setLocalError(undefined);
        try {
            await action();
        }
        catch (error) {
            this.input.setLocalError(authErrorMessage(error));
        }
        finally {
            this.input.setBusyAction(undefined);
        }
    }

    private async copyText(text: string): Promise<void> {
        this.input.setLocalError(undefined);
        const written = await writeTextToClipboard(text);
        written.foldLeft(this.input.setLocalError);
    }

    private appendAction(entry: CommandCenterRestActionLog): void {
        this.input.setActions((current) => [...current, entry].slice(-ACTION_LOG_LIMIT));
    }
}

function toAuthProbeRequest(apiBaseUrl: string, probe: AuthCommandCenterActions.Probe): RallarServerRestRequestInput {
    return {
        apiBaseUrl,
        method: 'POST',
        path: probe.path,
        headersText: '{}',
        queryText: '{}',
        bodyText: probe.bodyText,
        responseBodyMode: 'json',
        attachAuth: probe.attachAuth,
        authSession: probe.authSession,
        timeoutMs: 5_000,
        forbidPlaceholderBaseUrl: false
    };
}

/** A response without a complete ticket keeps the current one; its status already shows in the action log. */
function toCreatedTicket(
    response: RallarServerRestResponse,
    issuedAtEpochMs: number
): Either<string, AuthCommandCenterTicket> {
    const body = recordValue(response.bodyJson);
    if (
        response.ok &&
        typeof body.ticket === 'string' &&
        typeof body.sessionId === 'string' &&
        typeof body.expiresAtEpochMs === 'number'
    ) {
        return Either.ofRight({
            ticket: body.ticket,
            sessionId: body.sessionId,
            expiresAtEpochMs: body.expiresAtEpochMs,
            issuedAtEpochMs
        });
    }
    return Either.ofLeft(`WS ticket request returned ${response.status}`);
}

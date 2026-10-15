import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { RallarSessionHeartbeat } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    refreshStateHeartbeat,
    type RefreshStateHeartbeatResult,
    type StateHeartbeatWorkflowValue
} from '@shared-web/browser/session/refresh-state-heartbeat.ts';
import { adoptGroupSnapshotsFromHeartbeat } from '@shared-web/browser/state-cache/group-heartbeat-snapshot-adoption.ts';
import { emitBrowserStateReadDiagnostic } from '@shared-web/browser/state-read/diagnostics.ts';
import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID, type StateScope } from '@shared/api/state-types.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

export const SESSION_HEARTBEAT_INTERVAL_MS = 20_000;
export const SESSION_HEARTBEAT_RETRY_MS = 5_000;

export type InitHeartbeatOptions = Readonly<{
    authSession?: AuthSession;
    scope?: StateScope;
    policies?: CommandsOrchestratorPolicies<StateHeartbeatWorkflowValue>;
    onAuthInvalid?: (error: Error) => void | Promise<void>;
}>;

let activeHeartbeat: RallarSessionHeartbeat | undefined;

class BrowserStateHeartbeatRuntime {
    public readonly handle: RallarSessionHeartbeat;
    readonly #clientData: ClientInfo;
    readonly #options: InitHeartbeatOptions;
    #stopped = false;
    #stopRepeating: (() => void) | undefined;

    public constructor(clientData: ClientInfo, options: InitHeartbeatOptions) {
        this.#clientData = clientData;
        this.#options = options;
        this.handle = {
            sessionId: clientData.sessionId,
            generationId: crypto.randomUUID(),
            stop: () => this.stop()
        };
    }

    public start(): void {
        this.#stopRepeating = startRepeating({
            timers: createDefaultTimers(),
            intervalMs: SESSION_HEARTBEAT_INTERVAL_MS,
            retryBackoff: { baseMs: SESSION_HEARTBEAT_RETRY_MS, maxMs: SESSION_HEARTBEAT_RETRY_MS },
            firstRun: 'after-interval',
            run: () => this.runHeartbeat()
        });
    }

    private stop(): void {
        this.#stopped = true;
        this.#stopRepeating?.();
        if (activeHeartbeat === this.handle) {
            activeHeartbeat = undefined;
        }
    }

    /** A rejection asks the loop for the retry; a stopped or replaced heartbeat and an auth failure end quietly. */
    private async runHeartbeat(): Promise<void> {
        try {
            await this.refreshHeartbeat();
        }
        catch (error) {
            if (!this.isCurrent()) {
                return;
            }
            if (isUnauthorizedApiError(error)) {
                this.handle.stop();
                await this.#options.onAuthInvalid?.(error);
                return;
            }
            console.warn(
                `State heartbeat failed for client ${this.#clientData.clientId} session ${this.#clientData.sessionId}:`,
                error
            );
            throw error;
        }
    }

    private async refreshHeartbeat(): Promise<void> {
        const joinedGroups = groupStateSnapshotsRepository
            .getAllGroupStateSnapshots()
            .filter((snapshot) => isGroupSnapshotInScope(snapshot, this.#options.scope))
            .filter((snapshot) =>
                snapshot.activeSessions.some((session) => session.sessionId === this.#clientData.sessionId)
            );
        const refreshed = await refreshStateHeartbeat(this.#clientData, joinedGroups, {
            generationId: this.handle.generationId,
            clientSnapshot: clientStateSnapshotsRepository.findClientStateSnapshotByPrincipalId(
                this.#clientData.clientId
            ),
            authSession: this.#options.authSession,
            scope: this.#options.scope,
            policies: this.#options.policies
        });
        if (!this.isCurrent()) {
            return;
        }

        await writeHeartbeatResult(this.#clientData, joinedGroups, refreshed);
    }

    private isCurrent(): boolean {
        return !this.#stopped && activeHeartbeat === this.handle;
    }
}

export async function initHeartbeat(
    clientData: ClientInfo,
    options: InitHeartbeatOptions = {}
): Promise<RallarSessionHeartbeat> {
    activeHeartbeat?.stop();
    const runtime = new BrowserStateHeartbeatRuntime(clientData, options);
    activeHeartbeat = runtime.handle;
    runtime.start();
    return runtime.handle;
}

export function stopHeartbeat(
    handle: RallarSessionHeartbeat | undefined = activeHeartbeat
): void {
    handle?.stop();
}

async function writeHeartbeatResult(
    clientData: ClientInfo,
    joinedGroups: readonly GroupSnapshot[],
    refreshed: RefreshStateHeartbeatResult
): Promise<void> {
    clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId(
        refreshed.client.principal.principalId,
        refreshed.client
    );

    adoptGroupSnapshotsFromHeartbeat(joinedGroups, refreshed.groups);
    for (const missingGroup of refreshed.missingGroups) {
        const removed = groupStateSnapshotsRepository.removeGroupStateSnapshotIfUnchanged(
            missingGroup.group,
            missingGroup
        );
        emitBrowserStateReadDiagnostic({
            name: 'rallar.browser.state-read',
            feature: 'group',
            operation: 'heartbeat',
            result: removed ? 'removed' : 'preserved',
            durationMs: 0
        });
    }

    await Promise.all([
        clientStateSnapshotsRepository.waitForClientStateSnapshotChangesIdle(),
        groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle()
    ]);

    console.log(
        `State heartbeat refreshed for client ${clientData.clientId} and ${joinedGroups.length} groups`
    );
}

function isGroupSnapshotInScope(
    snapshot: GroupSnapshot,
    scope: StateScope | undefined
): boolean {
    if (!scope) {
        return true;
    }

    return snapshot.group.applicationId === scope.applicationId &&
        (snapshot.group.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID) === scope.workspaceId;
}

function isUnauthorizedApiError(error: unknown): error is ApiHttpError {
    return error instanceof ApiHttpError && error.status === 401;
}

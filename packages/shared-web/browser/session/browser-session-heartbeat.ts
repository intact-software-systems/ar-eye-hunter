import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { RallarSessionHeartbeat } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    refreshStateHeartbeat,
    type RefreshStateHeartbeatResult,
    type StateHeartbeatWorkflowValue
} from '@shared-web/browser/session/refresh-state-heartbeat.ts';
import { adoptGroupSnapshotsFromHeartbeat } from '@shared-web/browser/state-cache/group-heartbeat-snapshot-adoption.ts';
import { BROWSER_STATE_CACHE_TTL_MS } from '@shared-web/browser/state-cache/initialise-browser-cache-repositories.ts';
import { emitBrowserStateReadDiagnostic } from '@shared-web/browser/state-read/diagnostics.ts';
import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSession } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID, type StateScope } from '@shared/api/state-types.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import { createDefaultTimers, type Timers } from '@shared/resilience/timers.ts';

export const SESSION_HEARTBEAT_INTERVAL_MS = 20_000;
export const SESSION_HEARTBEAT_RETRY_MS = 5_000;
/** A renewal lands this long before the lease or the cache it keeps alive would lapse: one retry and its request. */
export const SESSION_HEARTBEAT_RENEWAL_MARGIN_MS = 2 * SESSION_HEARTBEAT_RETRY_MS;

/** The own session lease as the store last saw it: who stamped it last and when it lapses. */
interface SessionLease {
    readonly stampedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

interface FirstHeartbeatRenewalInput {
    readonly nowEpochMs: number;
    /** Undefined until a server snapshot or the issued session names the lease; the cache TTL alone bounds it then. */
    readonly leaseExpiresAtEpochMs: number | undefined;
    readonly cacheTtlMs: number;
    readonly marginMs: number;
}

interface HeartbeatRenewalInput {
    readonly nowEpochMs: number;
    readonly intervalMs: number;
    readonly marginMs: number;
    readonly lease: SessionLease | undefined;
}

type HeartbeatRenewalDecision = 'renew' | 'skip';

/** The renewal keeps the session lease and the browser cache alive, so the first one runs before either lapses. */
function computeFirstHeartbeatRenewalDelayMs(input: FirstHeartbeatRenewalInput): number {
    const leaseRemainingMs = input.leaseExpiresAtEpochMs === undefined
        ? input.cacheTtlMs
        : input.leaseExpiresAtEpochMs - input.nowEpochMs;
    return Math.max(0, Math.min(leaseRemainingMs, input.cacheTtlMs) - input.marginMs);
}

/** A lease another item stamped inside the interval needs no renewal, unless the next interval would come too late. */
function resolveHeartbeatRenewal(input: HeartbeatRenewalInput): HeartbeatRenewalDecision {
    if (
        input.lease === undefined ||
        input.lease.expiresAtEpochMs - input.nowEpochMs <= input.intervalMs + input.marginMs
    ) {
        return 'renew';
    }
    return input.lease.stampedAtEpochMs > input.nowEpochMs - input.intervalMs ? 'skip' : 'renew';
}

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
    readonly #timers: Timers = createDefaultTimers();
    #stopped = false;
    #cancelFirstRenewal: (() => void) | undefined;
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
        const firstRenewalDelayMs = computeFirstHeartbeatRenewalDelayMs({
            nowEpochMs: this.#timers.nowMs(),
            leaseExpiresAtEpochMs: this.readOwnSessionLease()?.expiresAtEpochMs ??
                this.#options.authSession?.expiresAtEpochMs,
            cacheTtlMs: BROWSER_STATE_CACHE_TTL_MS,
            marginMs: SESSION_HEARTBEAT_RENEWAL_MARGIN_MS
        });
        this.#cancelFirstRenewal = this.#timers.schedule(() => this.startRepeatingRenewals(), firstRenewalDelayMs);
    }

    private startRepeatingRenewals(): void {
        this.#cancelFirstRenewal = undefined;
        this.#stopRepeating = startRepeating({
            timers: this.#timers,
            intervalMs: SESSION_HEARTBEAT_INTERVAL_MS,
            retryBackoff: { baseMs: SESSION_HEARTBEAT_RETRY_MS, maxMs: SESSION_HEARTBEAT_RETRY_MS },
            firstRun: 'now',
            run: () => this.runHeartbeat()
        });
    }

    private stop(): void {
        this.#stopped = true;
        this.#cancelFirstRenewal?.();
        this.#stopRepeating?.();
        if (activeHeartbeat === this.handle) {
            activeHeartbeat = undefined;
        }
    }

    /** A rejection asks the loop for the retry; a stopped or replaced heartbeat and an auth failure end quietly. */
    private async runHeartbeat(): Promise<void> {
        const renewal = resolveHeartbeatRenewal({
            nowEpochMs: this.#timers.nowMs(),
            intervalMs: SESSION_HEARTBEAT_INTERVAL_MS,
            marginMs: SESSION_HEARTBEAT_RENEWAL_MARGIN_MS,
            lease: this.readOwnSessionLease()
        });
        if (renewal === 'skip') {
            return;
        }
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

    private readOwnSessionLease(): SessionLease | undefined {
        const ownSession = clientStateSnapshotsRepository
            .findClientStateSnapshotByPrincipalId(this.#clientData.clientId)
            ?.activeSessions.find((session: ClientSession) => session.sessionId === this.#clientData.sessionId);
        return ownSession === undefined
            ? undefined
            : { stampedAtEpochMs: ownSession.lastHeartbeatAtEpochMs, expiresAtEpochMs: ownSession.expiresAtEpochMs };
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

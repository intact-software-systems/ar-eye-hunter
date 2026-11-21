import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import type { BrowserOwnWsConnectionGeneration } from '@shared-web/browser/connection/browser-own-ws-connection-generation.ts';
import type { RallarSessionHeartbeat } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    refreshStateHeartbeat,
    type RefreshStateHeartbeatResult,
    type StateHeartbeatWorkflowValue
} from '@shared-web/browser/session/refresh-state-heartbeat.ts';
import { adoptGroupSnapshotsFromHeartbeat } from '@shared-web/browser/state-cache/group-heartbeat-snapshot-adoption.ts';
import { BROWSER_STATE_CACHE_TTL_MS } from '@shared-web/browser/state-cache/initialise-browser-cache-repositories.ts';
import { emitBrowserStateReadDiagnostic } from '@shared-web/browser/state-read/diagnostics.ts';
import { reconcileCompleteStateSnapshotCollections } from '@shared-web/browser/state-read/reconciliation.ts';
import { listStateGroups } from '@shared-web/browser/state-read/state-snapshot-http-api.ts';
import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import { validateAuthoritativeGroupSnapshotList } from '@shared/api/authoritative-state-validation.ts';
import type { ClientSession } from '@shared/api/client-types.ts';
import type { GroupPresencePublicationKey, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { createDefaultTimers, type Timers } from '@shared/resilience/timers.ts';
import { startRepeating } from '@shared/resilience/timing/start-repeating.ts';

import {
    canIssueGroupPresenceLease,
    captureGroupPresencePolicy,
    type RallarGroupPresencePolicy
} from './group-presence-policy.ts';

export const SESSION_HEARTBEAT_INTERVAL_MS = 20_000;
export const SESSION_HEARTBEAT_RETRY_MS = 5_000;
/** A renewal lands this long before the lease or the cache it keeps alive would lapse: one retry and its request. */
export const SESSION_HEARTBEAT_RENEWAL_MARGIN_MS = 2 * SESSION_HEARTBEAT_RETRY_MS;

export interface InitHeartbeatOptions {
    readonly creationEpochMs: () => number;
    readonly expiryEpochMs: () => number;
    readonly groupPresence?: RallarGroupPresencePolicy;
    /** What each group heartbeat registers on the page's presence row. */
    readonly publicationKey: GroupPresencePublicationKey | null;
    readonly authSession?: AuthSession;
    /** Absent for a heartbeat without a socket; the client session then keeps no socket generation. */
    readonly ownWsConnectionGeneration?: BrowserOwnWsConnectionGeneration;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<StateHeartbeatWorkflowValue>;
    readonly onAuthInvalid?: (error: Error) => void | Promise<void>;
}

/**
 * The own client-session lease as the store last saw it: when a client-session connect or renewal last stamped it,
 * and when it lapses.
 */
interface SessionLease {
    readonly stampedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

interface FirstHeartbeatRenewalInput {
    readonly nowEpochMs: number;
    /** Undefined until a client snapshot names the own client-session lease. */
    readonly leaseExpiresAtEpochMs: number | undefined;
    /** The issued access token's expiry: the browser's only bound until the client snapshot names the lease. */
    readonly accessTokenExpiresAtEpochMs: number | undefined;
    /** The earliest lapse among the cached snapshots of the groups this session joined, when any is cached. */
    readonly remainingCacheMs: number;
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

interface BrowserStateHeartbeatRuntimeDependencies {
    readonly timers: Timers;
    readonly newGenerationId: () => string;
}

let activeHeartbeat: RallarSessionHeartbeat | undefined;

class BrowserStateHeartbeatRuntime {
    public readonly handle: RallarSessionHeartbeat;
    readonly #clientData: ClientInfo;
    readonly #options: InitHeartbeatOptions;
    readonly #scope: StateScope;
    #groupRecoveryAtEpochMs = 0;
    readonly #timers: Timers;
    #stopped = false;
    #cancelFirstRenewal: (() => void) | undefined;
    #stopRepeating: (() => void) | undefined;

    public constructor(
        clientData: ClientInfo,
        options: InitHeartbeatOptions,
        dependencies: BrowserStateHeartbeatRuntimeDependencies
    ) {
        this.#timers = dependencies.timers;
        this.#clientData = clientData;
        this.#options = options;
        this.#scope = options.scope ?? defaultStateScope();
        this.handle = {
            sessionId: clientData.sessionId,
            generationId: dependencies.newGenerationId(),
            groupPresence: captureGroupPresencePolicy(options.groupPresence),
            stop: () => this.stop()
        };
    }

    public start(): void {
        this.#groupRecoveryAtEpochMs = this.readGroupCacheDeadline();
        const firstRenewalDelayMs = computeFirstHeartbeatRenewalDelayMs({
            nowEpochMs: this.#options.expiryEpochMs(),
            leaseExpiresAtEpochMs: this.readOwnSessionLease()?.expiresAtEpochMs,
            accessTokenExpiresAtEpochMs: this.#options.authSession?.expiresAtEpochMs,
            remainingCacheMs: this.#groupRecoveryAtEpochMs - this.#timers.nowMs(),
            cacheTtlMs: BROWSER_STATE_CACHE_TTL_MS,
            marginMs: SESSION_HEARTBEAT_RENEWAL_MARGIN_MS
        });
        this.#cancelFirstRenewal = this.#timers.schedule(
            () => this.startRepeatingRenewals(),
            Math.min(firstRenewalDelayMs, this.handle.groupPresence?.renewalIntervalMs ?? Number.POSITIVE_INFINITY)
        );
    }

    private startRepeatingRenewals(): void {
        this.#cancelFirstRenewal = undefined;
        this.#stopRepeating = startRepeating({
            timers: this.#timers,
            intervalMs: this.handle.groupPresence?.renewalIntervalMs ?? SESSION_HEARTBEAT_INTERVAL_MS,
            retryBackoff: {
                baseMs: this.handle.groupPresence?.retryMs ?? SESSION_HEARTBEAT_RETRY_MS,
                maxMs: this.handle.groupPresence?.retryMs ?? SESSION_HEARTBEAT_RETRY_MS
            },
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
        if (!this.isCurrent()) {
            return;
        }
        const renewal = resolveHeartbeatRenewal({
            nowEpochMs: this.#options.expiryEpochMs(),
            intervalMs: SESSION_HEARTBEAT_INTERVAL_MS,
            marginMs: SESSION_HEARTBEAT_RENEWAL_MARGIN_MS,
            lease: this.readOwnSessionLease()
        });
        if (!this.handle.groupPresence && renewal === 'skip' && this.#timers.nowMs() < this.#groupRecoveryAtEpochMs) {
            return;
        }
        try {
            const policy = this.handle.groupPresence;
            if (policy) {
                await new Command((signal) => this.refreshHeartbeat(signal), {
                    signal: this.#options.policies?.command?.signal,
                    timeoutMs: policy.requestTimeoutMs,
                    errorOnNull: false
                }).run();
            }
            else {
                await this.refreshHeartbeat(this.#options.policies?.command?.signal);
            }
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

    private async refreshHeartbeat(signal?: AbortSignal): Promise<void> {
        const wsConnectionGeneration = await new Command(
            (signal) => this.#options.ownWsConnectionGeneration?.read(signal),
            {
                signal,
                timeoutMs: this.handle.groupPresence?.requestTimeoutMs ?? this.#options.policies?.command?.timeoutMs ??
                    SESSION_HEARTBEAT_RETRY_MS,
                errorOnNull: false
            }
        ).run();
        signal?.throwIfAborted();
        if (!this.isCurrent()) {
            return;
        }
        if (this.#timers.nowMs() >= this.#groupRecoveryAtEpochMs) {
            await this.recoverGroupSnapshots(signal);
        }
        if (!this.isCurrent()) {
            return;
        }
        const heartbeatAtEpochMs = this.#options.creationEpochMs();
        const policy = this.handle.groupPresence;
        const joinedGroups =
            !policy || canIssueGroupPresenceLease(policy, this.#options.expiryEpochMs() - heartbeatAtEpochMs)
                ? this.readJoinedGroups()
                : [];
        const refreshed = await refreshStateHeartbeat(this.#clientData, joinedGroups, {
            heartbeatAtEpochMs,
            generationId: this.handle.generationId,
            wsConnectionGenerationId: wsConnectionGeneration?.right,
            clientSnapshot: clientStateSnapshotsRepository.findClientStateSnapshotByPrincipalId(
                this.#clientData.clientId
            ),
            publicationKey: this.#options.publicationKey,
            groupTtlMs: this.handle.groupPresence?.leaseMs,
            authSession: this.#options.authSession,
            scope: this.#scope,
            policies: this.handle.groupPresence
                ? {
                    command: {
                        ...this.#options.policies?.command,
                        signal,
                        timeoutMs: this.handle.groupPresence.requestTimeoutMs,
                        maxAttempts: 1
                    }
                }
                : this.#options.policies
        });
        signal?.throwIfAborted();
        if (!this.isCurrent()) {
            return;
        }

        const writtenAtEpochMs = this.#timers.nowMs();
        await writeHeartbeatResult(this.#clientData, joinedGroups, refreshed);
        signal?.throwIfAborted();
        if (!this.isCurrent()) {
            return;
        }
        if (refreshed.groups.length > 0) {
            this.#groupRecoveryAtEpochMs = Math.min(
                writtenAtEpochMs + BROWSER_STATE_CACHE_TTL_MS,
                this.readGroupCacheDeadline()
            );
        }
    }

    /** Cache expiry loses renewal targets, not membership. Re-read authority without admitting any room. */
    private async recoverGroupSnapshots(signal?: AbortSignal): Promise<void> {
        const observations = { clients: [], groups: this.readJoinedGroups() };
        const snapshots = await new Command(
            (signal) => listStateGroups(this.#scope, { signal, authSession: this.#options.authSession ?? null }),
            {
                signal,
                timeoutMs: this.handle.groupPresence?.requestTimeoutMs ?? this.#options.policies?.command?.timeoutMs ??
                    SESSION_HEARTBEAT_RETRY_MS
            }
        ).run();
        signal?.throwIfAborted();
        if (!this.isCurrent()) {
            return;
        }
        validateAuthoritativeGroupSnapshotList(snapshots, this.#scope);
        reconcileCompleteStateSnapshotCollections(observations, [], snapshots);
        groupStateSnapshotsRepository.setGroupStateSnapshots(snapshots);
        this.#groupRecoveryAtEpochMs = this.readGroupCacheDeadline();
    }

    private readGroupCacheDeadline(): number {
        return Math.min(
            this.#timers.nowMs() + BROWSER_STATE_CACHE_TTL_MS,
            computeEarliestExpiry(
                this.readJoinedGroups().map((snapshot) =>
                    groupStateSnapshotsRepository.findGroupStateSnapshotExpiresAtByRef(snapshot.group)
                )
            ) ?? Number.POSITIVE_INFINITY
        );
    }

    private readJoinedGroups(): GroupSnapshot[] {
        return groupStateSnapshotsRepository
            .getAllGroupStateSnapshots()
            .filter((snapshot) => isGroupSnapshotInScope(snapshot, this.#scope))
            .filter((snapshot) =>
                snapshot.activeSessions.some((session) =>
                    session.sessionId === this.#clientData.sessionId &&
                    session.principalId === this.#clientData.clientId
                )
            );
    }

    private isCurrent(): boolean {
        return !this.#stopped && activeHeartbeat === this.handle && !this.#options.policies?.command?.signal?.aborted;
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
    options: InitHeartbeatOptions
): Promise<RallarSessionHeartbeat> {
    activeHeartbeat?.stop();
    const runtime = new BrowserStateHeartbeatRuntime(clientData, options, {
        timers: createDefaultTimers(),
        newGenerationId: () => crypto.randomUUID()
    });
    activeHeartbeat = runtime.handle;
    runtime.start();
    return runtime.handle;
}

export function stopHeartbeat(
    handle: RallarSessionHeartbeat | undefined = activeHeartbeat
): void {
    handle?.stop();
}

/**
 * The renewal keeps the session lease and the browser cache alive, so the first one runs before the lease, a joined
 * group's cached snapshot or a snapshot written now would lapse.
 */
function computeFirstHeartbeatRenewalDelayMs(input: FirstHeartbeatRenewalInput): number {
    const leaseExpiry = input.leaseExpiresAtEpochMs ?? input.accessTokenExpiresAtEpochMs ?? Number.POSITIVE_INFINITY;
    const remainingMs = Math.min(
        leaseExpiry - input.nowEpochMs,
        input.remainingCacheMs,
        input.cacheTtlMs
    );
    return Math.max(0, remainingMs - input.marginMs);
}

/**
 * A lease a client-session connect stamped inside the interval needs no renewal, unless the next interval would come
 * too late. The stamp is on the server's clock: one ahead of the browser's proves nothing about the interval.
 */
function resolveHeartbeatRenewal(input: HeartbeatRenewalInput): HeartbeatRenewalDecision {
    if (
        input.lease === undefined ||
        input.lease.expiresAtEpochMs - input.nowEpochMs <= input.intervalMs + input.marginMs ||
        input.lease.stampedAtEpochMs > input.nowEpochMs
    ) {
        return 'renew';
    }
    return input.lease.stampedAtEpochMs > input.nowEpochMs - input.intervalMs ? 'skip' : 'renew';
}

function computeEarliestExpiry(expiries: readonly (number | undefined)[]): number | undefined {
    const known = expiries.filter((expiry): expiry is number => expiry !== undefined);
    return known.length === 0 ? undefined : Math.min(...known);
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
    scope: StateScope
): boolean {
    return snapshot.group.applicationId === scope.applicationId &&
        snapshot.group.workspaceId === scope.workspaceId;
}

function isUnauthorizedApiError(error: unknown): error is ApiHttpError {
    return error instanceof ApiHttpError && error.status === 401;
}

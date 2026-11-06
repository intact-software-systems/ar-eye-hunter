import type { PlayerInputState } from '@ar-eye-hunter/arena-contracts.ts';
import {
    decodeArenaTournamentSnapshot,
    type ArenaTournamentSnapshot
} from '@ar-eye-hunter/arena-tournament-snapshot.ts';
import type { TournamentArenaInput } from '@ar-eye-hunter/tournament-arena.ts';
import { readApiBaseUrl } from '@shared-web/browser/api-client-config.ts';
import { AuthenticatedResource } from '@shared-web/browser/api/authenticated-resource.ts';
import { readApiView } from '@shared-web/browser/api/read-api-view.ts';
import { sendApiHttpRequest } from '@shared-web/browser/api/send-api-http-request.ts';
import type { SubscribeViewRecovery } from '@shared-web/browser/api/subscribe-view-recovery.ts';
import { toAuthSessionKey } from '@shared-web/browser/auth/to-auth-session-key.ts';
import { BrowserActivity } from '@shared-web/browser/browser-activity.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord
} from '@shared/api/exact-object-decoding.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { wrapRallarMotionAngle } from '@shared/rallar-motion/math.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { ARENA_ROOM_SCOPE } from '../arena-runtime/arena-room-entry.ts';

import { ArenaTournamentFrames } from './arena-tournament-frames.ts';

export namespace ArenaTournamentClient {
    export interface Dependencies extends AuthenticatedResource.Dependencies {
        readonly browser: SubscribeViewRecovery.Browser;
    }
    export interface View {
        readonly tournament: ArenaTournamentSnapshot | null;
    }
    export interface Controls {
        readonly controls: PlayerInputState;
        readonly yaw: number;
        readonly pitch: number;
    }
    export interface PendingShot extends Controls {
        readonly sessionKey: string;
    }
    export interface Authority {
        readonly sessionKey: string;
        readonly inputSequence: number;
    }
}

/** Browser controls are proposals; every displayed score and position comes from the native game owner. */
export class ArenaTournamentClient extends AuthenticatedResource<ArenaTournamentClient.View, TournamentArenaInput> {
    private readonly controlsDependencies: AuthenticatedResource.Dependencies;
    private readonly frames: ArenaTournamentFrames;
    private sequence = 0;
    private lastSentAtEpochMs = 0;
    private pendingShot: ArenaTournamentClient.PendingShot | null = null;
    private controlsSubscriptions: SubscriptionScope | null = null;
    private cancelPendingShot: (() => void) | null = null;

    static createBrowser(roomId: string): ArenaTournamentClient {
        const dependencies: ArenaTournamentClient.Dependencies = {
            browser: rallar,
            auth: {
                session: () => rallar.session(),
                onChange: (listener, options) => rallar.auth.onChange(listener, options)
            },
            activity: new BrowserActivity(),
            timers: createDefaultTimers(),
            createId: () => crypto.randomUUID()
        };
        return new ArenaTournamentClient(dependencies, roomId);
    }

    constructor(dependencies: ArenaTournamentClient.Dependencies, roomId: string) {
        const ref = { ...ARENA_ROOM_SCOPE, groupId: roomId };
        const path = `/api/ar-eye/rooms/${encodeURIComponent(roomId)}/tournament`;
        super(dependencies, {
            scope: ARENA_ROOM_SCOPE,
            changeResult: 'stream',
            subscribeRefresh: (run) => this.frames.subscribe(dependencies.browser, run)
        }, {
            async read({ session, signal }) {
                const value = await readApiView({ baseUrl: readApiBaseUrl(), path, session, signal, timeoutMs: 5000 });
                try {
                    const tournament = value === null ? null : decodeArenaTournamentSnapshot(value);
                    if (tournament && !isSameGroupRef(tournament.binding.roomRef, ref)) {
                        throw new TypeError('Arena response belongs to another room');
                    }
                    return { tournament };
                }
                catch (cause) {
                    throw new Error('Invalid canonical arena snapshot', { cause });
                }
            },
            async change({ session, signal, request, requestId }) {
                return await new Command(async (attemptSignal) => {
                    const value = await sendApiHttpRequest({
                        baseUrl: readApiBaseUrl(),
                        path: `${path}/inputs/requests/${encodeURIComponent(requestId)}`,
                        method: 'POST',
                        body: request,
                        options: { authSession: session, signal: attemptSignal }
                    });
                    return decodeInputResponse(value, ref);
                }, { signal, timeoutMs: 5000, maxAttempts: 2, errorOnNull: false }).run();
            }
        });
        this.frames = new ArenaTournamentFrames(ref, {
            attempt: () => this.attempt(),
            current: (attempt) => this.current(attempt),
            isActive: () => dependencies.activity.isActive(),
            snapshot: () => this.getState().view?.tournament,
            publish: (attempt, tournament) => this.publishStreamView(attempt, { tournament })
        });
        this.controlsDependencies = dependencies;
    }

    override start(): Promise<void> {
        if (this.controlsSubscriptions === null) {
            this.controlsSubscriptions = new SubscriptionScope();
            this.controlsSubscriptions.add(this.onChange(() => this.progressPendingShot()));
            this.controlsSubscriptions.add(
                this.controlsDependencies.activity.onChange(() => {
                    if (!this.controlsDependencies.activity.isActive()) {
                        this.frames.discard();
                    }
                    this.progressPendingShot();
                })
            );
        }
        return super.start();
    }

    override stop(): void {
        this.frames.discard();
        this.clearPendingShot();
        const subscriptions = this.controlsSubscriptions;
        this.controlsSubscriptions = null;
        try {
            subscriptions?.unsubscribe();
        }
        finally {
            super.stop();
        }
    }

    protected override resolveReadView(
        view: ArenaTournamentClient.View,
        attempt: AuthenticatedResource.ReadInput
    ): ArenaTournamentClient.View {
        this.frames.authorize(attempt);
        const current = this.getState().view;
        const previous = current?.tournament;
        const incoming = view.tournament;
        return current && previous && incoming && jsonEquals(previous.binding, incoming.binding) &&
                previous.attemptRevision > incoming.attemptRevision
            ? current
            : view;
    }

    sendControls(input: ArenaTournamentClient.Controls): void {
        const authority = this.resolveControlsAuthority();
        if (authority === null) {
            this.clearPendingShot();
            return;
        }
        if (this.pendingShot?.sessionKey !== authority.sessionKey) {
            this.clearPendingShot();
        }
        if (input.controls.fire) {
            this.pendingShot = { ...input, controls: { ...input.controls }, sessionKey: authority.sessionKey };
        }
        else if (this.pendingShot !== null) {
            this.pendingShot = { ...this.pendingShot, controls: { ...input.controls } };
        }
        const view = this.getState();
        const now = this.controlsDependencies.timers.nowMs();
        if (view.busy || now - this.lastSentAtEpochMs < 50) {
            this.progressPendingShot();
            return;
        }
        this.lastSentAtEpochMs = now;
        if (view.retryPending) {
            this.clearPendingShot();
            void this.retry();
            return;
        }
        this.sequence = Math.max(this.sequence, authority.inputSequence) + 1;
        const shot = this.pendingShot;
        this.clearPendingShot();
        void this.act({
            yaw: wrapRallarMotionAngle(shot?.yaw ?? input.yaw, Math.PI * 2),
            pitch: shot?.pitch ?? input.pitch,
            controls: { ...input.controls, fire: shot !== null },
            sequence: this.sequence
        });
    }

    private resolveControlsAuthority(): ArenaTournamentClient.Authority | null {
        const tournament = this.getState().view?.tournament;
        const session = this.controlsDependencies.auth.session();
        const player = tournament?.state?.players.find((candidate) => candidate.principalId === session?.clientId);
        return this.controlsSubscriptions !== null && session && player && tournament?.status === 'playing' &&
                tournament.state?.arena.match?.status === 'active' && this.controlsDependencies.activity.isActive()
            ? { sessionKey: toAuthSessionKey(session), inputSequence: player.input.sequence }
            : null;
    }

    private progressPendingShot(): void {
        this.cancelPendingShot?.();
        this.cancelPendingShot = null;
        const shot = this.pendingShot;
        if (shot === null) {
            return;
        }
        const authority = this.resolveControlsAuthority();
        const view = this.getState();
        if (
            authority === null || shot.sessionKey !== authority.sessionKey || view.error !== null || view.retryPending
        ) {
            this.pendingShot = null;
            return;
        }
        if (view.busy) {
            return;
        }
        const delayMs = Math.max(0, 50 - (this.controlsDependencies.timers.nowMs() - this.lastSentAtEpochMs));
        this.cancelPendingShot = this.controlsDependencies.timers.schedule(() => this.writePendingShot(), delayMs);
    }

    private writePendingShot(): void {
        this.cancelPendingShot = null;
        const shot = this.pendingShot;
        const authority = this.resolveControlsAuthority();
        const view = this.getState();
        if (
            shot === null || authority === null || shot.sessionKey !== authority.sessionKey || view.error !== null ||
            view.retryPending
        ) {
            this.clearPendingShot();
            return;
        }
        if (!view.busy) {
            this.sendControls({ controls: { ...shot.controls, fire: false }, yaw: shot.yaw, pitch: shot.pitch });
        }
    }

    private clearPendingShot(): void {
        this.cancelPendingShot?.();
        this.cancelPendingShot = null;
        this.pendingShot = null;
    }
}

function decodeInputResponse(
    value: unknown,
    ref: GroupRef
): string | null {
    const result = requireRecord(value, 'Arena input result');
    requireExactKeys(result, ['status', 'roomRef', 'reason', 'simulatedAtEpochMs', 'complete'], 'Arena input result');
    const room = requireRecord(result.roomRef, 'Arena input room');
    requireExactKeys(room, ['applicationId', 'workspaceId', 'groupId'], 'Arena input room');
    if (
        room.applicationId !== ref.applicationId || room.workspaceId !== ref.workspaceId || room.groupId !== ref.groupId
    ) {
        throw new TypeError('Arena input result belongs to another room');
    }
    const status = requireOneOf(result.status, ['applied', 'refused'], 'Arena input status');
    if (typeof result.complete !== 'boolean' || !(result.reason === null || typeof result.reason === 'string')) {
        throw new TypeError('Invalid arena input result');
    }
    if (result.simulatedAtEpochMs !== null) {
        requireEpoch(result.simulatedAtEpochMs, 'Arena simulation time');
    }
    if (status === 'applied') {
        return null;
    }
    return result.reason === 'input-rate' || result.reason === 'catching-up' || result.reason === 'stale-input'
        ? null
        : `Tournament controls refused: ${result.reason}`;
}

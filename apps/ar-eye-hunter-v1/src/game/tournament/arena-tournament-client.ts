import type { PlayerInputState } from '@ar-eye-hunter/arena-contracts.ts';
import {
    decodeArenaTournamentSnapshot,
    type ArenaTournamentSnapshot
} from '@ar-eye-hunter/arena-tournament-snapshot.ts';
import type { TournamentArenaInput } from '@ar-eye-hunter/tournament-arena.ts';
import { readApiBaseUrl } from '@shared-web/browser/api-client-config.ts';
import { AuthenticatedResource } from '@shared-web/browser/api/authenticated-resource.ts';
import { sendApiHttpRequest } from '@shared-web/browser/api/send-api-http-request.ts';
import { BrowserActivity } from '@shared-web/browser/browser-activity.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { requireEpoch, requireExactKeys, requireOneOf, requireRecord } from '@shared/api/exact-object-decoding.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { wrapRallarMotionAngle } from '@shared/rallar-motion/math.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { ARENA_ROOM_SCOPE } from '../arena-runtime/arena-room-entry.ts';

export namespace ArenaTournamentClient {
    export interface View {
        readonly tournament: ArenaTournamentSnapshot | null;
    }
    export interface Controls {
        readonly controls: PlayerInputState;
        readonly yaw: number;
        readonly pitch: number;
    }
}

/** Browser controls are proposals; every displayed score and position comes from the native game owner. */
export class ArenaTournamentClient extends AuthenticatedResource<ArenaTournamentClient.View, TournamentArenaInput> {
    private readonly controlsDependencies: AuthenticatedResource.Dependencies;
    private sequence = 0;
    private lastSentAtEpochMs = 0;
    private pendingShot: { readonly principalId: string; readonly yaw: number; readonly pitch: number; } | null = null;

    static createBrowser(roomId: string): ArenaTournamentClient {
        const dependencies: AuthenticatedResource.Dependencies = {
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

    constructor(dependencies: AuthenticatedResource.Dependencies, roomId: string) {
        const ref = { ...ARENA_ROOM_SCOPE, groupId: roomId };
        const path = `/api/ar-eye/rooms/${encodeURIComponent(roomId)}/tournament`;
        let casualRoom = false;
        super(dependencies, { scope: ARENA_ROOM_SCOPE, refreshIntervalMs: 200 }, {
            async read({ session, signal }) {
                if (casualRoom) {
                    return { tournament: null };
                }
                const value = await sendApiHttpRequest({
                    baseUrl: readApiBaseUrl(),
                    path,
                    method: 'GET',
                    body: undefined,
                    options: { authSession: session, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }
                });
                const tournament = value === null ? null : decodeArenaTournamentSnapshot(value);
                if (tournament && !isSameGroupRef(tournament.binding.roomRef, ref)) {
                    throw new TypeError('Arena response belongs to another room');
                }
                casualRoom = tournament === null;
                return { tournament };
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
        this.controlsDependencies = dependencies;
    }

    sendControls(input: ArenaTournamentClient.Controls): void {
        const view = this.getState();
        const tournament = view.view?.tournament;
        const principalId = this.controlsDependencies.auth.session()?.clientId;
        const player = tournament?.state?.players.find((candidate) => candidate.principalId === principalId);
        if (
            !player || tournament?.status !== 'playing' || tournament.state?.arena.match?.status !== 'active' ||
            !this.controlsDependencies.activity.isActive()
        ) {
            return;
        }
        if (this.pendingShot?.principalId !== principalId) {
            this.pendingShot = null;
        }
        if (input.controls.fire) {
            this.pendingShot = { principalId: player.principalId, yaw: input.yaw, pitch: input.pitch };
        }
        const now = this.controlsDependencies.timers.nowMs();
        if (view.busy || now - this.lastSentAtEpochMs < 50) {
            return;
        }
        this.lastSentAtEpochMs = now;
        if (view.retryPending) {
            void this.retry();
            return;
        }
        this.sequence = Math.max(this.sequence, player.input.sequence) + 1;
        const shot = this.pendingShot;
        const controls = { ...input.controls, fire: shot !== null };
        this.pendingShot = null;
        void this.act({
            ...input,
            yaw: wrapRallarMotionAngle(shot?.yaw ?? input.yaw, Math.PI * 2),
            pitch: shot?.pitch ?? input.pitch,
            controls,
            sequence: this.sequence
        });
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

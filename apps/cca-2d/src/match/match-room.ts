import type {
    RallarDirectorRelayHandle,
    RallarDirectorStatus
} from '@shared-web/browser/director/rallar-director-facade.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { resolveRallarGroupDirectorAppointmentEligibility } from '@shared/api/group-director.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { Timers } from '@shared/resilience/timers.ts';

import type { TownMatchIdentity } from './town-match.ts';

export namespace TownMatchRoom {
    export interface Dependencies {
        readonly browser: Pick<RallarFacade, 'director' | 'rooms' | 'session' | 'isConnected'>;
        readonly timers: Timers;
    }
    export interface View {
        readonly director: RallarDirectorStatus;
        readonly members: readonly TownMatchIdentity[];
    }
}

/** Owns the room lease, authoritative membership observation and eligible director appointment. */
export class TownMatchRoom {
    private readonly dependencies: TownMatchRoom.Dependencies;
    private readonly roomRef: GroupRef;
    private readonly relay: RallarDirectorRelayHandle<null, null>;
    private readonly lifetime = new AbortController();
    private lastRefreshAt = 0;

    constructor(dependencies: TownMatchRoom.Dependencies, roomRef: GroupRef) {
        this.dependencies = dependencies;
        this.roomRef = roomRef;
        this.relay = dependencies.browser.director.createRelay<null, null>({
            roomRef,
            topicId: 'app.cca.authority',
            intentTypeId: 'cca.authority.intent',
            outputTypeId: 'cca.authority.output',
            heartbeatIntervalMs: 750,
            snapshotIntervalMs: false
        });
    }

    getView(): TownMatchRoom.View {
        const browser = this.dependencies.browser;
        const snapshot = browser.rooms.current();
        const names = browser.rooms.state().members;
        const now = this.dependencies.timers.nowMs();
        const members = snapshot && isSameGroupRef(snapshot.group, this.roomRef)
            ? snapshot.activeSessions.filter((session) =>
                session.status === 'active' && session.expiresAtEpochMs > now &&
                snapshot.members.some((member) =>
                    member.principalId === session.principalId && member.status === 'active' &&
                    member.role !== 'spectator'
                )
            ).map((session) => ({
                id: session.principalId,
                sessionId: session.sessionId,
                displayName: names.find((member) => member.principalId === session.principalId)?.displayName ||
                    session.principalId
            })).sort((left, right) => left.id.localeCompare(right.id))
            : [];
        return { director: browser.director.status(this.roomRef), members };
    }

    async appoint(): Promise<void> {
        await this.dependencies.browser.director.appoint(this.roomRef, {
            heartbeatTtlMs: 4000,
            timeoutMs: 1000,
            maxAttempts: 1,
            signal: this.lifetime.signal
        });
    }

    async refreshForRecovery(): Promise<void> {
        const browser = this.dependencies.browser;
        const now = this.dependencies.timers.nowMs();
        if (this.lifetime.signal.aborted || !browser.isConnected() || now - this.lastRefreshAt < 1000) {
            return;
        }
        this.lastRefreshAt = now;
        await browser.rooms.session(this.roomRef).refresh({
            timeoutMs: 1000,
            maxAttempts: 1,
            signal: this.lifetime.signal
        });
        if (this.lifetime.signal.aborted || !browser.isConnected()) {
            return;
        }
        const view = this.getView();
        const snapshot = browser.rooms.current();
        if (view.director.isFresh || !snapshot || !isSameGroupRef(snapshot.group, this.roomRef)) {
            return;
        }
        const candidate = view.members.find((member) =>
            resolveRallarGroupDirectorAppointmentEligibility({
                snapshot,
                principalId: member.id,
                sessionId: member.sessionId
            }).allowed
        );
        if (candidate?.sessionId === browser.session()?.sessionId) {
            await this.appoint();
        }
    }

    stop(): void {
        this.lifetime.abort();
        this.relay.stop();
    }
}

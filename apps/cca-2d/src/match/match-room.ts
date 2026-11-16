import type {
    RallarDirectorRelayHandle,
    RallarDirectorStatus
} from '@shared-web/browser/director/rallar-director-facade.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import {
    resolveRallarGroupDirectorAppointmentEligibility,
    type RallarGroupDirectorAppointmentEligibility
} from '@shared/api/group-director.ts';
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
        readonly departedIds: readonly string[];
        readonly appointmentEligibility: RallarGroupDirectorAppointmentEligibility;
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
        const departedIds = snapshot && isSameGroupRef(snapshot.group, this.roomRef)
            ? snapshot.members.filter((member) => member.status !== 'active').map((member) => member.principalId)
            : [];
        const session = browser.session();
        const appointmentEligibility = resolveRallarGroupDirectorAppointmentEligibility({
            snapshot: snapshot && isSameGroupRef(snapshot.group, this.roomRef) ? snapshot : undefined,
            principalId: session?.clientId,
            sessionId: session?.sessionId
        });
        return { director: browser.director.status(this.roomRef), members, departedIds, appointmentEligibility };
    }

    async appoint(): Promise<void> {
        await this.dependencies.browser.director.appoint(this.roomRef, {
            heartbeatTtlMs: 4000,
            timeoutMs: 1000,
            maxAttempts: 1,
            signal: this.lifetime.signal
        });
    }

    /** Refreshes authoritative presence and reports whether this browser should attempt appointment. */
    async refreshForRecovery(): Promise<boolean> {
        const browser = this.dependencies.browser;
        const now = this.dependencies.timers.nowMs();
        if (this.lifetime.signal.aborted || !browser.isConnected() || now - this.lastRefreshAt < 1000) {
            return false;
        }
        this.lastRefreshAt = now;
        await browser.rooms.session(this.roomRef).refresh({
            timeoutMs: 1000,
            maxAttempts: 1,
            signal: this.lifetime.signal
        });
        if (this.lifetime.signal.aborted || !browser.isConnected()) {
            return false;
        }
        const view = this.getView();
        const snapshot = browser.rooms.current();
        if (
            view.director.isFresh || view.director.active || !snapshot || !isSameGroupRef(snapshot.group, this.roomRef)
        ) {
            return false;
        }
        const candidate = view.members.find((member) =>
            resolveRallarGroupDirectorAppointmentEligibility({
                snapshot,
                principalId: member.id,
                sessionId: member.sessionId
            }).allowed
        );
        return candidate !== undefined && candidate.sessionId === browser.session()?.sessionId;
    }

    stop(): void {
        this.lifetime.abort();
        this.relay.stop();
    }
}

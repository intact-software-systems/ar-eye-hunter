import type {
    RallarDirectorRelayHandle,
    RallarDirectorStatus
} from '@shared-web/browser/director/rallar-director-facade.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { roomGuestAccessMode } from '@shared/api/room-guests/access.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { RallarGroupDirectorAppointmentEligibility } from '@shared/api/group-director.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { Timers } from '@shared/resilience/timers.ts';

import { readRoomDirectorSuccession } from '@shared/api/room-directors/room-director-succession-record.ts';
import { initialTownHostPolicy, townHostCommand } from './town-host-command.ts';
import type { TownMatchIdentity } from './town-match.ts';

export namespace TownMatchRoom {
    export interface Dependencies {
        readonly browser: Pick<RallarFacade, 'compareDeadline' | 'deadlineAfter' | 'rtc' | 'director' | 'rooms' | 'session' | 'isConnected'>;
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
    private previousGuestPeers = new Set<string>();

    constructor(dependencies: TownMatchRoom.Dependencies, roomRef: GroupRef) {
        this.dependencies = dependencies;
        this.roomRef = roomRef;
        this.relay = dependencies.browser.director.createRelay<null, null>({
            roomRef,
            topicId: 'app.grumpy-town.authority',
            intentTypeId: 'grumpy-town.authority.intent',
            outputTypeId: 'grumpy-town.authority.output',
            heartbeatIntervalMs: 750,
            snapshotIntervalMs: false
        });
    }

    getView(): TownMatchRoom.View {
        const browser = this.dependencies.browser;
        const snapshot = browser.rooms.current();
        const names = browser.rooms.state().members;
        const upperServerTime = browser.deadlineAfter(0);
        const usableMembers = snapshot?.members.filter(member => member.status === 'active' && member.role !== 'spectator' &&
            (!member.guestLease || (upperServerTime !== undefined && browser.isConnected() &&
                roomGuestAccessMode(snapshot.group, member, upperServerTime) !== 'expired')));
        const members = snapshot && isSameGroupRef(snapshot.group, this.roomRef)
            ? snapshot.activeSessions.filter((session) =>
                session.status === 'active' && browser.compareDeadline(session.expiresAtEpochMs) === 'before' &&
                usableMembers?.some(member => member.principalId === session.principalId)
            ).map((session) => ({
                id: session.principalId,
                sessionId: session.sessionId,
                displayName: snapshot.members.find(member => member.principalId === session.principalId)?.guestLease?.displayName ||
                    names.find((member) => member.principalId === session.principalId)?.displayName ||
                    session.principalId
            })).sort((left, right) => left.id.localeCompare(right.id))
            : [];
        const departedIds = snapshot && isSameGroupRef(snapshot.group, this.roomRef)
            ? snapshot.members.filter((member) => member.status !== 'active').map((member) => member.principalId)
            : [];
        const session = browser.session();
        const appointmentEligibility: RallarGroupDirectorAppointmentEligibility = session && this.hostCommand(session.clientId, session.sessionId, members)
            ? { allowed: true, status: 'allowed' }
            : { allowed: false, status: 'not-authorized', reason: 'Waiting for the host or the next eligible player.' };
        return { director: browser.director.status(this.roomRef), members, departedIds, appointmentEligibility };
    }

    /** Guests have a room-scoped identity. Closing their old channels cannot disrupt a different room. */
    reconcileGuestPeers(view: TownMatchRoom.View): void {
        const browser = this.dependencies.browser;
        const snapshot = browser.rooms.current();
        const local = browser.session();
        const localGuest = snapshot?.members.some(member => member.principalId === local?.clientId && member.guestLease);
        const next = new Set(view.members.filter(member => member.sessionId !== local?.sessionId &&
            (localGuest || snapshot?.members.some(candidate => candidate.principalId === member.id && candidate.guestLease)))
            .map(member => member.sessionId));
        if (localGuest && !view.members.some(member => member.sessionId === local?.sessionId)) next.clear();
        for (const peer of this.previousGuestPeers) {
            if (!next.has(peer)) browser.rtc.disconnectPeer(peer);
        }
        this.previousGuestPeers = next;
    }

    async appoint(): Promise<void> {
        const browser = this.dependencies.browser;
        const session = browser.session();
        const command = session && this.hostCommand(session.clientId, session.sessionId, this.getView().members);
        if (!command) throw new Error('The town is waiting for an eligible host.');
        const options = { signal: this.lifetime.signal };
        const room = browser.rooms.current();
        if (command.operation === 'appoint' && room && !readRoomDirectorSuccession(room.group.metadata)) {
            await browser.rooms.changeDirector(this.roomRef, initialTownHostPolicy, crypto.randomUUID(), options);
        }
        await browser.rooms.changeDirector(this.roomRef, command, crypto.randomUUID(), options);
        await browser.rooms.session(this.roomRef).refresh({ signal: this.lifetime.signal });
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
        const candidate = view.members.find(member => this.hostCommand(member.id, member.sessionId, view.members));
        return candidate !== undefined && candidate.sessionId === browser.session()?.sessionId;
    }

    private hostCommand(principalId: string, sessionId: string, members: readonly TownMatchIdentity[]) {
        const browser = this.dependencies.browser;
        const snapshot = browser.rooms.current();
        const member = snapshot?.members.find(candidate => candidate.principalId === principalId);
        if (!snapshot || !isSameGroupRef(snapshot.group, this.roomRef) || !member ||
            !members.some(candidate => candidate.id === principalId && candidate.sessionId === sessionId)) return undefined;
        if (member.guestLease && browser.compareDeadline(member.guestLease.expiresAtEpochMs) !== 'before') return undefined;
        return townHostCommand(snapshot.group.metadata, { principalId, sessionId, role: member.role }, browser.compareDeadline);
    }

    stop(): void {
        this.lifetime.abort();
        this.relay.stop();
    }
}

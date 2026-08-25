import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessage } from '@shared-web/browser/rallar.ts';
import { isRallarGameEnvelope } from '../envelopes.ts';
import {
    decodeRallarGameHostCapability,
    publishRallarGameHostCapability,
    resolveDefaultRallarGamePeerIds
} from '../match/match-capability.ts';
import type { RallarGameMatchConfig, RallarGameTypeIds } from '../match/rallar-game-match-contracts.ts';
import type { RallarGameMatchRoutingRuntime } from '../match/rallar-game-match-routing-runtime.ts';
import type { RallarGameMatchStatusRuntime } from '../match/rallar-game-match-status-runtime.ts';
import type { RallarGameSendResult } from '../transport/rallar-game-send-result.ts';
import {
    DEFAULT_RALLAR_GAME_CAPABILITY_TTL_MS,
    electRallarGameHost,
    scoreRallarGameHostCapability,
    type RallarGameHostCapability,
    type RallarGameHostElectionResult
} from './election.ts';
import type { RallarGameDirectorAppointmentRuntime } from './rallar-game-director-appointment-runtime.ts';

export namespace RallarGameHostElectionRuntime {
    export interface Input<TInput, TIntent, TSnapshot, TEvent, TPresence> {
        readonly config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence>;
        readonly typeIds: RallarGameTypeIds;
        readonly routing: RallarGameMatchRoutingRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
        readonly appointment: RallarGameDirectorAppointmentRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
        readonly status: RallarGameMatchStatusRuntime;
        readRoomTarget(): RallarGameMatchStatusRuntime.RoomTarget;
        readLocalPeerId(): string | undefined;
    }
}

/** Owns browser host capability reports and deterministic host election inputs. */
export class RallarGameHostElectionRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence> {
    private readonly input: RallarGameHostElectionRuntime.Input<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private readonly capabilitiesByPeerId = new Map<string, RallarGameHostCapability>();
    private readonly capabilityTtlMs: number;

    constructor(
        input: RallarGameHostElectionRuntime.Input<TInput, TIntent, TSnapshot, TEvent, TPresence>
    ) {
        this.input = input;
        this.capabilityTtlMs = input.config.capabilityTtlMs ?? DEFAULT_RALLAR_GAME_CAPABILITY_TTL_MS;
    }

    get capabilities(): readonly RallarGameHostCapability[] {
        return [...this.capabilitiesByPeerId.values()];
    }

    election(): RallarGameHostElectionResult {
        const roomState = this.input.config.rallar.rooms.state();
        const peerIds = this.input.config.resolvePeerIds
            ? this.input.config.resolvePeerIds(roomState)
            : resolveDefaultRallarGamePeerIds(roomState, this.input.readLocalPeerId());
        const appointmentEligibility = this.input.appointment.eligibility();
        const capabilities = [...this.capabilitiesByPeerId.values()];
        if (!appointmentEligibility.allowed && appointmentEligibility.localPeerId) {
            const previous = this.capabilitiesByPeerId.get(appointmentEligibility.localPeerId);
            capabilities.push({
                ...previous,
                peerId: appointmentEligibility.localPeerId,
                reportedAtEpochMs: Date.now(),
                canHost: false
            });
        }

        return electRallarGameHost({
            peerIds,
            capabilities,
            capabilityTtlMs: this.capabilityTtlMs,
            scoreHost: this.input.config.scoreHost ?? scoreRallarGameHostCapability
        });
    }

    async reportCapability(
        capability: Partial<RallarGameHostCapability> = {}
    ): Promise<RallarGameSendResult> {
        if (this.input.status.isStopped) {
            return { status: 'stopped', reason: 'Rallar Game match is stopped.' };
        }

        const localPeerId = this.input.readLocalPeerId();
        if (!localPeerId) {
            return {
                status: 'failed',
                reason: 'Cannot report capability without a local session.'
            };
        }

        const room = this.input.readRoomTarget();
        if (!room.roomId) {
            return {
                status: 'failed',
                reason: 'Cannot report capability without a room.'
            };
        }

        const configuredCapability = this.input.config.readCapability?.() ?? {};
        const appointmentEligibility = this.input.appointment.eligibility();
        const reportedAtEpochMs = Date.now();
        const report: RallarGameHostCapability = {
            ...configuredCapability,
            ...capability,
            canHost: appointmentEligibility.allowed
                ? (capability.canHost ?? configuredCapability.canHost)
                : false,
            peerId: localPeerId,
            reportedAtEpochMs
        };
        this.capabilitiesByPeerId.set(localPeerId, report);

        const envelope = this.input.routing.createEnvelope('capability', report, {
            directorEpoch: this.input.status.current.directorEpoch ?? 0,
            roomId: room.roomId,
            senderId: localPeerId,
            sentAtEpochMs: reportedAtEpochMs
        });
        const result = await publishRallarGameHostCapability({
            config: this.input.config,
            typeId: this.input.typeIds.capability,
            room: { roomId: room.roomId, roomRef: room.roomRef },
            envelope
        });
        this.input.status.refresh();
        return result;
    }

    async handleCapabilityMessage(
        message: RallarMessage<RallarMessagePayload>
    ): Promise<void> {
        if (
            this.input.status.isStopped ||
            !isRallarGameEnvelope(message.payload, this.input.config.protocol) ||
            !this.input.routing.acceptEnvelope(message.payload, 'capability', {
                senderId: message.senderId,
                checkDirectorEpoch: false
            })
        ) {
            return;
        }

        const capability = decodeRallarGameHostCapability(message.payload);
        if (!capability) {
            return;
        }

        this.capabilitiesByPeerId.set(capability.peerId, capability);
        this.input.status.refresh();
    }
}

import {
    isRelicSnapshot,
    type RelicActionInput,
    type RelicExpeditionSetupMetadata,
    type RelicGameState,
    type RelicPendingAction,
    type RelicPublicSetupMetadata
} from '@relic-hunters/mod.ts';
import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

export function decodeRelicGameStateAppData(value: JsonWireValue): RelicGameState {
    const state = requireObject(value, 'Relic game state');
    const createdAtEpochMs = requireFiniteNumber(
        state.createdAtEpochMs,
        'Relic game state createdAtEpochMs'
    );
    const pendingActions = decodePendingActions(state.pendingActions);
    const setup = decodeSetup(state.setup);
    const publicSnapshotCandidate = {
        ...state,
        submittedPlayerIds: pendingActions.map((pending) => pending.playerId),
        setup: toPublicSetup(setup)
    };
    if (!isRelicSnapshot(publicSnapshotCandidate)) {
        throw new TypeError('Relic game state does not match the current persisted shape.');
    }

    return {
        protocolVersion: publicSnapshotCandidate.protocolVersion,
        gameId: publicSnapshotCandidate.gameId,
        roomId: publicSnapshotCandidate.roomId,
        phase: publicSnapshotCandidate.phase,
        round: publicSnapshotCandidate.round,
        maxRounds: publicSnapshotCandidate.maxRounds,
        createdAtEpochMs,
        updatedAtEpochMs: publicSnapshotCandidate.updatedAtEpochMs,
        ...(publicSnapshotCandidate.adminPlayerId === undefined
            ? {}
            : { adminPlayerId: publicSnapshotCandidate.adminPlayerId }),
        roundTimeLimitMs: publicSnapshotCandidate.roundTimeLimitMs,
        ...(publicSnapshotCandidate.roundStartedAtEpochMs === undefined
            ? {}
            : { roundStartedAtEpochMs: publicSnapshotCandidate.roundStartedAtEpochMs }),
        map: publicSnapshotCandidate.map,
        relics: publicSnapshotCandidate.relics,
        roomInvestigations: publicSnapshotCandidate.roomInvestigations,
        players: publicSnapshotCandidate.players,
        pendingActions,
        events: publicSnapshotCandidate.events,
        winnerIds: publicSnapshotCandidate.winnerIds,
        ...(setup === undefined ? {} : { setup })
    };
}

function decodePendingActions(
    value: JsonWireValue | undefined
): readonly RelicPendingAction[] {
    if (!Array.isArray(value)) {
        throw new TypeError('Relic game state pendingActions must be an array.');
    }
    return value.map(decodePendingAction);
}

function decodePendingAction(value: JsonWireValue): RelicPendingAction {
    const pending = requireObject(value, 'Relic pending action');
    if (
        typeof pending.playerId !== 'string' ||
        typeof pending.username !== 'string'
    ) {
        throw new TypeError('Relic pending action identity is malformed.');
    }
    return {
        playerId: pending.playerId,
        username: pending.username,
        action: decodeAction(pending.action),
        submittedAtEpochMs: requireFiniteNumber(
            pending.submittedAtEpochMs,
            'Relic pending action submittedAtEpochMs'
        )
    };
}

function decodeAction(value: JsonWireValue | undefined): RelicActionInput {
    const action = requireObject(value, 'Relic pending action input');
    if (
        action.kind !== 'move' &&
        action.kind !== 'search' &&
        action.kind !== 'steal' &&
        action.kind !== 'escape'
    ) {
        throw new TypeError('Relic pending action kind is malformed.');
    }
    const targetRoomId = decodeOptionalString(
        action.targetRoomId,
        'Relic targetRoomId'
    );
    const targetPlayerId = decodeOptionalString(
        action.targetPlayerId,
        'Relic targetPlayerId'
    );
    return {
        kind: action.kind,
        ...(targetRoomId === undefined ? {} : { targetRoomId }),
        ...(targetPlayerId === undefined ? {} : { targetPlayerId })
    };
}

function decodeSetup(
    value: JsonWireValue | undefined
): RelicExpeditionSetupMetadata | undefined {
    if (value === undefined) {
        return undefined;
    }
    const setup = requireObject(value, 'Relic expedition setup');
    if (
        setup.schemaVersion !== 1 ||
        (
            setup.source !== 'default' &&
            setup.source !== 'procedural' &&
            setup.source !== 'rallar-ai' &&
            setup.source !== 'mock'
        )
    ) {
        throw new TypeError('Relic expedition setup metadata is malformed.');
    }
    const seed = decodeOptionalString(setup.seed, 'Relic setup seed');
    const theme = decodeOptionalString(setup.theme, 'Relic setup theme');
    const blueprintId = decodeOptionalString(
        setup.blueprintId,
        'Relic setup blueprintId'
    );
    return {
        schemaVersion: 1,
        source: setup.source,
        ...(seed === undefined ? {} : { seed }),
        ...(theme === undefined ? {} : { theme }),
        ...(blueprintId === undefined ? {} : { blueprintId })
    };
}

function toPublicSetup(
    setup: RelicExpeditionSetupMetadata | undefined
): RelicPublicSetupMetadata | undefined {
    if (!setup) {
        return undefined;
    }
    return {
        schemaVersion: setup.schemaVersion,
        source: setup.source,
        ...(setup.theme === undefined ? {} : { theme: setup.theme })
    };
}

function requireObject(
    value: JsonWireValue | undefined,
    label: string
): JsonWireObject {
    if (!isJsonWireObject(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    return value;
}

function isJsonWireObject(
    value: JsonWireValue | undefined
): value is JsonWireObject {
    return value !== undefined &&
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value);
}

function requireFiniteNumber(
    value: JsonWireValue | undefined,
    label: string
): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${label} must be a finite number.`);
    }
    return value;
}

function decodeOptionalString(
    value: JsonWireValue | undefined,
    label: string
): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string when present.`);
    }
    return value;
}

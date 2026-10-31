import {
    requireExactKeys,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import {
    isRelicCommand,
    RELIC_PROTOCOL_VERSION,
    type RelicActionKind,
    type RelicCharacterId,
    type RelicCommand,
    type RelicRematchCommand
} from '../mod.ts';

/** Complete durable command shape; optional browser inputs are normalized before reservation. */
export type RelicGameMove =
    | RelicRematchCommand
    | (
        & Readonly<{
            protocolVersion: typeof RELIC_PROTOCOL_VERSION;
            gameId: string;
            username: string;
        }>
        & (
            | Readonly<{ kind: 'join-expedition'; characterId: RelicCharacterId | null; }>
            | Readonly<{
                kind:
                    | 'start-expedition'
                    | 'force-resolve-round'
                    | 'continue-review'
                    | 'leave-expedition'
                    | 'take-keeper';
            }>
            | Readonly<{ kind: 'pickup-relic'; relicId: string; }>
            | Readonly<{ kind: 'set-round-limit'; timeLimitMs: number; }>
            | Readonly<{
                kind: 'submit-action';
                action: Readonly<
                    { kind: RelicActionKind; targetRoomId: string | null; targetPlayerId: string | null; }
                >;
            }>
        )
    );

export function isRelicGameMoveInput(value: unknown): value is RelicCommand {
    if (!isRelicCommand(value)) {
        return false;
    }
    try {
        captureRelicGameMove(value);
        return true;
    }
    catch (error) {
        if (error instanceof TypeError) {
            return false;
        }
        throw error;
    }
}

export function captureRelicGameMove(command: RelicCommand): RelicGameMove {
    if (command.kind === 'join-expedition') {
        return decodeRelicGameMove({ ...command, characterId: command.characterId ?? null });
    }
    if (command.kind === 'submit-action') {
        return decodeRelicGameMove({
            ...command,
            action: {
                ...command.action,
                targetRoomId: command.action.targetRoomId ?? null,
                targetPlayerId: command.action.targetPlayerId ?? null
            }
        });
    }
    return decodeRelicGameMove(command);
}

export function decodeRelicGameMove(value: unknown): RelicGameMove {
    const move = requireRecord(value, 'Relic durable move');
    const keys = ['protocolVersion', 'gameId', 'username', 'kind'];
    switch (move.kind) {
        case 'set-rematch-ready':
            requireExactKeys(
                move,
                [...keys, 'completedGameId', 'settingsKey', 'ready', 'characterId', 'participationKey'],
                'Relic rematch readiness'
            );
            break;
        case 'start-rematch':
            requireExactKeys(move, [...keys, 'completedGameId', 'settingsKey'], 'Relic rematch start');
            break;
        case 'set-rematch-round-limit':
            requireExactKeys(
                move,
                [...keys, 'completedGameId', 'settingsKey', 'timeLimitMs'],
                'Relic rematch settings'
            );
            break;
        case 'join-expedition':
            requireExactKeys(move, [...keys, 'characterId'], 'Relic join move');
            requireNullableString(move.characterId, 'Relic character ID');
            break;
        case 'submit-action': {
            requireExactKeys(move, [...keys, 'action'], 'Relic action move');
            const action = requireRecord(move.action, 'Relic action');
            requireExactKeys(action, ['kind', 'targetRoomId', 'targetPlayerId'], 'Relic action');
            requireNullableString(action.targetRoomId, 'Relic target room ID');
            requireNullableString(action.targetPlayerId, 'Relic target player ID');
            break;
        }
        case 'pickup-relic':
            requireExactKeys(move, [...keys, 'relicId'], 'Relic pickup move');
            break;
        case 'set-round-limit':
            requireExactKeys(move, [...keys, 'timeLimitMs'], 'Relic time limit move');
            break;
        default:
            requireExactKeys(move, keys, 'Relic move');
    }
    // The complete durable shape above establishes nullability; the public decoder owns game discriminants.
    const durable = move as RelicGameMove;
    if (!isRelicCommand(toRelicCommand(durable))) {
        throw new TypeError('Invalid Relic move');
    }
    return durable;
}

export function toRelicCommand(move: RelicGameMove): RelicCommand {
    if (move.kind === 'join-expedition') {
        const { characterId, ...command } = move;
        return characterId === null ? command : { ...command, characterId };
    }
    if (move.kind === 'submit-action') {
        const { targetRoomId, targetPlayerId, kind } = move.action;
        return {
            ...move,
            action: {
                kind,
                ...(targetRoomId === null ? {} : { targetRoomId }),
                ...(targetPlayerId === null ? {} : { targetPlayerId })
            }
        };
    }
    return move;
}

function requireNullableString(value: unknown, label: string): void {
    if (value !== null) {
        requireString(value, label);
    }
}

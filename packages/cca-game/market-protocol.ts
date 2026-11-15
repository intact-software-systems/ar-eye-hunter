import type { GroupRef } from '@shared/api/group-types.ts';
import type { MarketState } from './market-rules.ts';

export const MARKET_INPUT_TOPIC = 'room.cca-input';
export const MARKET_STATE_TOPIC = 'rallar.cca-state';
export const MARKET_SCOPE = { applicationId: 'cca-2d', workspaceId: 'default' } as const;
export interface MarketInputMessage {
    readonly version: 1;
    readonly roomRef: GroupRef;
    readonly incarnation: string;
    readonly controller: string;
    readonly sequence: number;
    readonly x: number;
    readonly y: number;
    readonly bank: boolean;
    readonly dash: number;
}
export interface MarketSnapshot {
    readonly version: 1;
    readonly roomRef: GroupRef;
    readonly incarnation: string;
    readonly state: MarketState;
}
export function isMarketInput(value: unknown): value is MarketInputMessage {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const input = value as Record<string, unknown>;
    if (typeof input.roomRef !== 'object' || input.roomRef === null) {
        return false;
    }
    const room = input.roomRef as Record<string, unknown>;
    return input.version === 1 && room.applicationId === MARKET_SCOPE.applicationId &&
        room.workspaceId === MARKET_SCOPE.workspaceId &&
        typeof room.groupId === 'string' && room.groupId.length > 0 && room.groupId.length <= 200 &&
        typeof input.incarnation === 'string' && input.incarnation.length <= 100 &&
        typeof input.controller === 'string' && input.controller.length > 0 && input.controller.length <= 100 &&
        Number.isSafeInteger(input.sequence) && Number(input.sequence) > 0 &&
        typeof input.x === 'number' && Number.isFinite(input.x) && Math.abs(input.x) <= 1 &&
        typeof input.y === 'number' && Number.isFinite(input.y) && Math.abs(input.y) <= 1 &&
        typeof input.bank === 'boolean' && Number.isSafeInteger(input.dash) && Number(input.dash) >= 0;
}

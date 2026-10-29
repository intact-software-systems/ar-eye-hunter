import type { RelicActionInput, RelicCharacterId, RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import { createRelicRematch } from '@relic-hunters/src/relic-rematch.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { readRallarGameParticipants } from '@shared/rallar-game/read-rallar-game-participants.ts';

export type RelicRematchDraft =
    | { readonly kind: 'set-rematch-ready'; readonly ready: boolean; readonly characterId: RelicCharacterId; }
    | { readonly kind: 'start-rematch'; }
    | { readonly kind: 'set-rematch-round-limit'; readonly timeLimitMs: number; };

export type RelicCommandDraft =
    | (Exclude<RelicRematchDraft, { kind: 'set-rematch-ready'; }> & {
        readonly completedGameId: string;
        readonly settingsKey: string;
    })
    | (Extract<RelicRematchDraft, { kind: 'set-rematch-ready'; }> & {
        readonly completedGameId: string;
        readonly settingsKey: string;
        readonly participationKey: string;
    })
    | { readonly kind: 'join-expedition'; readonly characterId?: RelicCharacterId; }
    | { readonly kind: 'start-expedition'; }
    | { readonly kind: 'take-keeper'; }
    | { readonly kind: 'submit-action'; readonly action: RelicActionInput; }
    | { readonly kind: 'force-resolve-round'; }
    | { readonly kind: 'pickup-relic'; readonly relicId: string; }
    | { readonly kind: 'continue-review'; }
    | { readonly kind: 'set-round-limit'; readonly timeLimitMs: number; };

export interface RelicRematchDraftInput {
    readonly snapshot: RelicPublicSnapshot | undefined;
    readonly room: GroupSnapshot | undefined;
    readonly sessionId: string | undefined;
    readonly now: number;
    readonly request: RelicRematchDraft;
}

/** Capture the exact game, settings and membership displayed when the player clicked. */
export function createRelicRematchDraft(
    { snapshot, room, sessionId, now, request }: RelicRematchDraftInput
): RelicCommandDraft | undefined {
    if (!snapshot || snapshot.phase !== 'finished') {
        return undefined;
    }
    const rematch = snapshot.rematch ?? createRelicRematch(snapshot).right;
    if (!rematch) {
        return undefined;
    }
    const identity = {
        completedGameId: rematch.preparation.completedGameId,
        settingsKey: rematch.preparation.settingsKey
    };
    if (request.kind !== 'set-rematch-ready') {
        return { ...request, ...identity };
    }
    const participant = readRallarGameParticipants(room, now).find((entry) => entry.sessionId === sessionId);
    return participant ? { ...request, ...identity, participationKey: participant.participationKey } : undefined;
}

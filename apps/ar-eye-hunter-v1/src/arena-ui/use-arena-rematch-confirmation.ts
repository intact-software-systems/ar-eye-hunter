import {
    useEffect,
    useRef,
    useState
} from 'react';

import type { RallarGameParticipant } from '@shared/rallar-game/rematch.ts';
import { Either } from '@shared/resilience/Either.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type { ArenaMatchState } from '@ar-eye-hunter/arena-contracts.ts';
import type { ArenaRematch } from '@ar-eye-hunter/arena-rematch.ts';
import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
import type { ArenaRematchDraft } from '../game/arena-runtime/game-actions/use-arena-world-actions.ts';

interface ArenaRematchConfirmationInput {
    readonly arena: ArenaConnection;
    readonly match: ArenaMatchState;
    readonly rematch: ArenaRematch | undefined;
    readonly member: RallarGameParticipant | undefined;
}

interface PendingArenaRematch {
    readonly draft: ArenaRematchDraft;
    readonly completedGameId: string;
    readonly settingsKey: string;
    readonly sessionId: string;
    readonly participationKey: string;
    readonly initialError: string | undefined;
}

interface ArenaRematchConfirmation {
    readonly pending: boolean;
    readonly error: string | undefined;
    send(draft: ArenaRematchDraft): void;
}

const timers = createDefaultTimers();

export function useArenaRematchConfirmation(input: ArenaRematchConfirmationInput): ArenaRematchConfirmation {
    const [pending, setPending] = useState<PendingArenaRematch>();
    const [error, setError] = useState<string>();
    const owner = useRef<PendingArenaRematch | undefined>(undefined);
    const finish = (attempt: PendingArenaRematch, failure?: string) => {
        if (owner.current !== attempt) {
            return;
        }
        owner.current = undefined;
        setPending(undefined);
        setError(failure);
    };
    useEffect(() => () => {
        owner.current = undefined;
    }, []);
    useEffect(() => {
        if (pending) {
            return timers.schedule(
                () =>
                    finish(pending, 'The director has not confirmed this change. Check your connection and try again.'),
                10_000
            );
        }
    }, [pending]);
    useEffect(() => {
        if (!pending) {
            return;
        }
        const result = computeArenaRematchConfirmation(pending, input);
        result.fold((failure) => finish(pending, failure), (confirmed) => {
            if (confirmed) {
                finish(pending);
            }
        });
    }, [pending, input.match, input.member, input.arena.error]);
    return {
        pending: pending !== undefined,
        error,
        send: (draft) => {
            if (owner.current || !input.rematch || !input.member) {
                return;
            }
            const attempt: PendingArenaRematch = {
                draft,
                ...input.member,
                completedGameId: input.match.matchId,
                settingsKey: input.rematch.preparation.settingsKey,
                initialError: input.arena.error
            };
            owner.current = attempt;
            setPending(attempt);
            setError(undefined);
            void submitArenaRematchAction(input.arena, draft).then((result) =>
                result.fold((failure) => finish(attempt, failure.message), () => undefined)
            );
        }
    };
}

async function submitArenaRematchAction(
    arena: ArenaConnection,
    draft: ArenaRematchDraft
): Promise<Either<Error, 'sent'>> {
    try {
        if (draft.kind === 'ready') {
            await arena.setRematchReady(draft.ready);
        }
        else if (draft.kind === 'settings') {
            await arena.setRematchDuration(draft.durationMs);
        }
        else {
            await arena.startRematch();
        }
        return Either.ofRight('sent');
    }
    catch (error) {
        return Either.ofLeft(toError(error));
    }
}

function computeArenaRematchConfirmation(
    pending: PendingArenaRematch,
    input: ArenaRematchConfirmationInput
): Either<string, boolean> {
    const { match, rematch, member, arena } = input;
    if (arena.error && arena.error !== pending.initialError) {
        return Either.ofLeft(arena.error);
    }
    if (member?.sessionId !== pending.sessionId || member.participationKey !== pending.participationKey) {
        return Either.ofLeft('Your room participation changed. Check the current room and try again.');
    }
    if (pending.draft.kind === 'start' && match.status === 'active' && match.matchId !== pending.completedGameId) {
        return Either.ofRight(true);
    }
    if (match.matchId !== pending.completedGameId || match.status !== 'complete' || !rematch) {
        return Either.ofLeft('The match changed. Check the current match before trying again.');
    }
    if (pending.draft.kind === 'settings') {
        return Either.ofRight(rematch.durationMs === pending.draft.durationMs);
    }
    if (rematch.preparation.settingsKey !== pending.settingsKey) {
        return Either.ofLeft('The next match settings changed. Check them and confirm again.');
    }
    const player = rematch.preparation.players.find((entry) => entry.sessionId === pending.sessionId);
    return Either.ofRight(
        pending.draft.kind === 'ready' && player?.ready === pending.draft.ready &&
            (!player.ready || player.participationKey === pending.participationKey)
    );
}

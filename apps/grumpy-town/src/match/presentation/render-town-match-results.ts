import { requirePracticeElement } from '../../practice-controls.ts';
import { TOWN_MATCH_MAX_TICKS } from '../match-extension.ts';
import type { TownMatchSession } from '../town-match-session.ts';

export function renderTownMatchResults(root: HTMLElement, view: TownMatchSession.View): void {
    const match = view.match;
    const interrupted = Boolean(view.interruption) || match?.phase === 'interrupted';
    const finished = match?.phase === 'finished' || interrupted;
    const nextReady = requirePracticeElement<HTMLButtonElement>(root, '#ready-next');
    nextReady.hidden = !match || match.phase === 'lobby' || match.participants.some(player => player.id === view.localId);
    nextReady.disabled = !view.available || view.recovering || Boolean(match?.members.find(member => member.id === view.localId)?.ready);
    nextReady.textContent = nextReady.disabled && view.available && !view.recovering ? 'Ready for next round ✓' : 'Ready for next round';
    const extend = requirePracticeElement<HTMLButtonElement>(root, '#extend-round');
    extend.hidden = !view.isDirector || match?.phase !== 'playing';
    extend.disabled = !view.available || view.recovering || !match ||
        match.tick + match.remainingTicks >= TOWN_MATCH_MAX_TICKS;
    requirePracticeElement(root, '#leave-round').hidden = finished;
    requirePracticeElement(root, '#round-results').hidden = !finished;
    requirePracticeElement(root, '#round-result-title').textContent = interrupted
        ? 'Round interrupted'
        : 'Round complete';
    requirePracticeElement(root, '#rematch').hidden = !view.isDirector;
    requirePracticeElement<HTMLButtonElement>(root, '#rematch').disabled = !view.available ||
        (match?.phase !== 'interrupted' && match?.phase !== 'finished');
    requirePracticeElement<HTMLButtonElement>(root, '#leave-results').disabled = !view.available;
    const points = match?.participants.map((participant) =>
        `${participant.displayName}: ${match.players.find((player) => player.id === participant.id)?.score ?? 0}`
    ).join(' · ');
    requirePracticeElement(root, '#round-winners').textContent = interrupted
        ? `${view.interruption ?? match?.interruption} Confirmed points: ${points}`
        : match?.results.map((result) =>
            `${result.displayName}: ${result.score}${result.qualified ? ' — WINNER!' : ''}`
        ).join(' · ') ?? '';
}

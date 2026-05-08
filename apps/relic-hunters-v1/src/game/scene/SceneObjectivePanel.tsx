import type { RelicActionInput } from '@relic-hunters/mod.ts';
import type { SceneObjective } from './objectives.ts';

export function SceneObjectivePanel({
    objective,
    onPrimeAction,
}: Readonly<{
    objective: SceneObjective;
    onPrimeAction(action: RelicActionInput): void;
}>) {
    return (
        <aside
            className={[
                'scene-objective-panel',
                `tone-${objective.tone}`,
                objective.urgent ? 'urgent' : '',
                objective.investigated ? 'investigated' : '',
            ].filter(Boolean).join(' ')}
            aria-label="Room objective"
        >
            <span>{objective.eyebrow}</span>
            <strong>{objective.title}</strong>
            <small>{objective.detail}</small>
            {objective.investigationSummary && (
                <small className="scene-objective-note">{objective.investigationSummary}</small>
            )}
            {objective.danger && <em className="danger-note">{objective.danger}</em>}
            {objective.investigated && <em>Clue trail marked</em>}
            {objective.recommendedAction && (
                <button
                    type="button"
                    onClick={() => onPrimeAction(objective.recommendedAction!)}
                >
                    {primeLabel(objective.recommendedAction)}
                </button>
            )}
        </aside>
    );
}

function primeLabel(action: RelicActionInput): string {
    switch (action.kind) {
        case 'move':
            return 'Prime Move';
        case 'search':
            return 'Prime Search';
        case 'escape':
            return 'Prime Escape';
        case 'steal':
            return 'Prime Steal';
    }
}

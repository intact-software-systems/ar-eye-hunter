import type { RelicActionInput } from '@relic-hunters/mod.ts';
import type { ScenePrompt } from './types.ts';

export function SceneInteractionPrompt({
    prompt,
    onPrimeAction,
}: Readonly<{
    prompt?: ScenePrompt;
    onPrimeAction(action: RelicActionInput): void;
}>) {
    if (!prompt) {
        return null;
    }

    const action: RelicActionInput = prompt.kind === 'move'
        ? { kind: 'move', targetRoomId: prompt.roomId }
        : { kind: 'search' };

    return (
        <button
            type="button"
            className={prompt.kind === 'search' && prompt.inspecting
                ? 'scene-interaction-prompt inspecting'
                : 'scene-interaction-prompt'}
            onClick={() => onPrimeAction(action)}
        >
            <span>
                {prompt.kind === 'move'
                    ? 'Doorway'
                    : prompt.inspecting
                    ? 'Inspecting'
                    : 'Clue'}
            </span>
            <strong>
                {prompt.kind === 'move'
                    ? `Move to ${prompt.roomName}`
                    : prompt.label}
            </strong>
            <small>
                {prompt.kind === 'move'
                    ? 'Locks in only when you submit the turn plan'
                    : prompt.detail}
            </small>
        </button>
    );
}

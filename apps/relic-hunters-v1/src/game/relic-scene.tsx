import { useMemo } from 'react';
import { isRelicTournamentTerminal } from './scene/neon/compute-relic-terminal-presentation-key.ts';

import { type RelicActionInput, type RelicPublicSnapshot } from '@relic-hunters/mod.ts';

import { type RelicPickupPrompt } from './scene/neon/relic-relics.ts';
import { useRelicScene } from './scene/neon/use-relic-scene.ts';
import { deriveSceneObjective } from './scene/objectives.ts';
import { type RelicCameraMode } from './scene/relic-scene-model.ts';
import { SceneInteractionPrompt } from './scene/SceneInteractionPrompt.tsx';
import { SceneObjectivePanel } from './scene/SceneObjectivePanel.tsx';

export interface RelicSceneProps {
    readonly snapshot: RelicPublicSnapshot;
    readonly localPlayerId: string | undefined;
    readonly selectedRoomId: string | undefined;
    readonly primedAction: RelicActionInput | undefined;
    readonly focusRoomId: string | undefined;
    readonly rtcReady: boolean;
    readonly inputEnabled: boolean;
    readonly reviewDirector: boolean;
    onSelectRoom(roomId: string): void;
    onPrimeAction(action: RelicActionInput): void;
    onPickupRelic(relicId: string): void;
    onReviewPlaybackComplete(): void;
}

interface ScenePickupPromptProps {
    readonly prompt: RelicPickupPrompt | undefined;
    onPickup(relicId: string): void;
}

interface SceneViewControlsProps {
    readonly mode: RelicCameraMode;
    onChange(mode: RelicCameraMode): void;
}

interface SceneViewControl {
    readonly mode: RelicCameraMode;
    readonly label: string;
    readonly shortLabel: string;
    readonly ariaLabel: string;
}

const VIEW_CONTROLS: readonly SceneViewControl[] = [
    { mode: 'avatar', label: 'Avatar', shortLabel: '3rd', ariaLabel: 'Avatar view' },
    { mode: 'first-person', label: 'Visor', shortLabel: '1st', ariaLabel: 'First-person view' },
    { mode: 'overview', label: 'Overview', shortLabel: 'Map', ariaLabel: 'Overview view' },
    { mode: 'flyover', label: 'Flyover', shortLabel: 'Fly', ariaLabel: 'Fly over rooms' }
];

export function RelicScene(props: RelicSceneProps) {
    const scene = useRelicScene(props);
    const interactive = props.inputEnabled && !isRelicTournamentTerminal(props.snapshot);
    const objective = useMemo(() => deriveSceneObjective(props), [
        props.snapshot,
        props.localPlayerId,
        props.primedAction
    ]);
    if (scene.error) {
        return (
            <div className="relic-scene-fallback">
                <strong>Neon scene failed to boot.</strong>
                <span>{scene.error}</span>
            </div>
        );
    }
    return (
        <>
            <canvas
                ref={scene.canvasRef}
                className="relic-scene relic-scene-next"
                data-scene-runtime="next"
                data-scene-visual-theme="neon-dystopian"
                tabIndex={0}
                aria-label="Relic Hunters neon cyber-dojo canvas"
            />
            <SceneViewControls mode={scene.cameraMode} onChange={scene.changeCameraMode} />
            <SceneObjectivePanel
                objective={{
                    ...objective,
                    recommendedAction: interactive ? objective.recommendedAction : undefined,
                    eyebrow: objective.eyebrow === 'Expedition' ? 'Compliance Quest' : objective.eyebrow,
                    detail: objective.detail.replaceAll('castle', 'facility').replaceAll('ruin', 'facility')
                }}
                onPrimeAction={props.onPrimeAction}
            />
            <SceneInteractionPrompt
                prompt={interactive ? scene.prompt : undefined}
                onPrimeAction={props.onPrimeAction}
            />
            <ScenePickupPrompt prompt={interactive ? scene.pickupPrompt : undefined} onPickup={props.onPickupRelic} />
        </>
    );
}

function ScenePickupPrompt({ prompt, onPickup }: ScenePickupPromptProps) {
    if (!prompt) {
        return null;
    }
    return (
        <div className="scene-pickup-prompt" role="status" aria-live="polite">
            <span>E Pick Up</span>
            <strong>{prompt.name}</strong>
            <small>{prompt.value} pts. Asset Management is already disappointed.</small>
            <button type="button" onClick={() => onPickup(prompt.relicId)}>Pick Up</button>
        </div>
    );
}

function SceneViewControls({ mode, onChange }: SceneViewControlsProps) {
    return (
        <div className="scene-view-controls" role="group" aria-label="Scene view controls">
            {VIEW_CONTROLS.map((control) => (
                <button
                    key={control.mode}
                    type="button"
                    className={mode === control.mode ? 'active' : undefined}
                    aria-label={control.ariaLabel}
                    aria-pressed={mode === control.mode}
                    onClick={() => onChange(control.mode)}
                >
                    <span className="view-label-full">{control.label}</span>
                    <span className="view-label-short">{control.shortLabel}</span>
                </button>
            ))}
        </div>
    );
}

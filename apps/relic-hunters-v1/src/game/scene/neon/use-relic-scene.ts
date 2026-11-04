import { useEffect, useRef, useState, type RefObject } from 'react';

import { type RelicSceneProps } from '../../relic-scene.tsx';
import { subscribeRelicScenePositionUpdates } from '../networking.ts';
import { type RelicCameraMode } from '../relic-scene-model.ts';
import { type ScenePrompt } from '../types.ts';
import { readStoredCameraMode, resolveDefaultCameraMode } from './relic-camera.ts';
import { type RelicPickupPrompt } from './relic-relics.ts';
import { createRelicSceneLifecycle, RelicSceneLifecycle } from './relic-scene-lifecycle.ts';
import { type RelicSceneRuntime } from './relic-scene-runtime.ts';

interface RelicScenePresentation {
    readonly canvasRef: RefObject<HTMLCanvasElement | null>;
    readonly error: string | undefined;
    readonly prompt: ScenePrompt | undefined;
    readonly pickupPrompt: RelicPickupPrompt | undefined;
    readonly cameraMode: RelicCameraMode;
    changeCameraMode(mode: RelicCameraMode): void;
}

export function useRelicScene(props: RelicSceneProps): RelicScenePresentation {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const lifecycleRef = useRef<RelicSceneLifecycle | undefined>(undefined);
    const [error, setError] = useState<string | undefined>();
    const [prompt, onPromptChange] = useState<ScenePrompt | undefined>();
    const [pickupPrompt, onPickupPromptChange] = useState<RelicPickupPrompt | undefined>();
    const [cameraMode, onCameraModeChange] = useState(() =>
        resolveDefaultCameraMode(props.snapshot, props.localPlayerId, readStoredCameraMode())
    );
    const input: Omit<RelicSceneRuntime.Input, 'canvas'> = {
        ...props,
        onPromptChange,
        onPickupPromptChange,
        onCameraModeChange
    };
    const inputRef = useRef(input);
    useEffect(() => {
        inputRef.current = input;
        if (canvasRef.current) {
            lifecycleRef.current?.update({ ...input, canvas: canvasRef.current });
        }
    }, [input]);
    useEffect(() => {
        if (!canvasRef.current) {
            return;
        }
        try {
            const lifecycle = createRelicSceneLifecycle({ ...inputRef.current, canvas: canvasRef.current });
            lifecycleRef.current = lifecycle;
            onCameraModeChange(lifecycle.runtime.cameraMode.value);
            return () => {
                lifecycle.dispose();
                lifecycleRef.current = undefined;
            };
        }
        catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        }
    }, []);
    useEffect(() => {
        const runtime = lifecycleRef.current?.runtime;
        return input.rtcReady && runtime ? subscribeRelicScenePositionUpdates(runtime) : undefined;
    }, [input.rtcReady]);
    return {
        canvasRef,
        error,
        prompt,
        pickupPrompt,
        cameraMode,
        changeCameraMode: (mode) => lifecycleRef.current?.changeCameraMode(mode)
    };
}

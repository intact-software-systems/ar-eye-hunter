import {
    useEffect,
    useRef,
    type RefObject
} from 'react';

import { ArenaCanvasRuntime } from './scene/arena-canvas-runtime.ts';
import type { BabylonArenaProps } from './scene/arena-scene-contracts.ts';
import { ArenaSceneControls, useArenaSceneControls } from './scene/arena-scene-controls.tsx';
import type { ArenaSceneRuntime } from './scene/arena-scene-runtime.ts';

interface ArenaCanvasView {
    readonly canvasRef: RefObject<HTMLCanvasElement | null>;
    readonly runtimeRef: RefObject<ArenaSceneRuntime | undefined>;
    readonly controls: ReturnType<typeof useArenaSceneControls>;
}

export function BabylonArena(props: BabylonArenaProps) {
    const { canvasRef, runtimeRef, controls } = useArenaCanvasRuntime(props);
    return (
        <div className="arena-shell" data-room-ready={props.roomReady ? 'true' : 'false'}>
            <canvas
                ref={canvasRef}
                className="arena-canvas"
                aria-label="AR Eye Hunter gameplay canvas"
                {...props.diagnosticsAttributes}
            />
            {!props.roomReady && (
                <div className="arena-blocker">
                    <div className="arena-blocker__panel">
                        Solo systems hot. Join or create a Rallar room for peer chaos.
                    </div>
                </div>
            )}
            <div className="crosshair" aria-hidden="true">
                <span />
            </div>
            <ArenaSceneControls controls={controls} runtimeRef={runtimeRef} />
            <div className="mobile-rotate-prompt" role="status">
                <strong>Rotate for combat</strong>
                <span>Landscape gives your thumbs room to misbehave.</span>
            </div>
        </div>
    );
}

function useArenaCanvasRuntime(props: BabylonArenaProps): ArenaCanvasView {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const runtimeRef = useRef<ArenaSceneRuntime | undefined>(undefined);
    const propsRef = useRef(props);
    const canvasRuntimeRef = useRef<ArenaCanvasRuntime | undefined>(undefined);
    const controls = useArenaSceneControls(runtimeRef, props.localColor);
    useEffect(() => {
        propsRef.current = props;
    }, [props]);
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        const runtime = new ArenaCanvasRuntime(canvas);
        canvasRuntimeRef.current = runtime;
        return () => {
            runtimeRef.current = undefined;
            canvasRuntimeRef.current = undefined;
            runtime.stop();
        };
    }, []);
    useEffect(() => {
        runtimeRef.current = canvasRuntimeRef.current?.startScene({
            props: propsRef,
            mobileSettings: controls.mobileSettings,
            audioSettings: controls.audioSettings,
            clock: { nowEpochMs: Date.now, nowMonotonicMs: () => performance.now() }
        });
    }, [props.localColor, props.localSessionId, props.localUsername, props.roomId]);
    return { canvasRef, runtimeRef, controls };
}

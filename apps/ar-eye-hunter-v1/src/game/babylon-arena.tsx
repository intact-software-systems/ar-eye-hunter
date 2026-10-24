import { useEffect, useRef } from 'react';
import type { BabylonArenaProps } from './scene/arena-scene-contracts.ts';
import { ArenaSceneControls, useArenaSceneControls } from './scene/arena-scene-controls.tsx';
import { ArenaSceneRuntime } from './scene/arena-scene-runtime.ts';

export function BabylonArena(props: BabylonArenaProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const runtimeRef = useRef<ArenaSceneRuntime | undefined>(undefined);
    const propsRef = useRef(props);
    const controls = useArenaSceneControls(runtimeRef, props.localColor);
    useEffect(() => {
        propsRef.current = props;
    }, [props]);
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        const runtime = new ArenaSceneRuntime({
            canvas,
            props: propsRef,
            mobileSettings: controls.mobileSettings,
            audioSettings: controls.audioSettings,
            clock: { nowEpochMs: Date.now, nowMonotonicMs: () => performance.now() }
        });
        runtimeRef.current = runtime;
        runtime.start();
        return () => {
            runtime.stop();
            runtimeRef.current = undefined;
        };
    }, [props.localColor, props.localSessionId, props.localUsername, props.roomId]);
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

import { Engine } from '@babylonjs/core/Engines/engine.js';

import { ArenaSceneRuntime } from './arena-scene-runtime.ts';

export namespace ArenaCanvasRuntime {
    export type SceneInput = Omit<ArenaSceneRuntime.Input, 'canvas' | 'engine'>;
}

/** Owns the canvas engine across independently disposable room scenes. */
export class ArenaCanvasRuntime {
    private readonly canvas: HTMLCanvasElement;
    private readonly engine: Engine;
    private scene: ArenaSceneRuntime | undefined;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.engine = new Engine(canvas, true, { antialias: true, preserveDrawingBuffer: true, stencil: true });
    }

    startScene(input: ArenaCanvasRuntime.SceneInput): ArenaSceneRuntime {
        this.scene?.stop();
        this.scene = undefined;
        const scene = new ArenaSceneRuntime({ ...input, canvas: this.canvas, engine: this.engine });
        this.scene = scene;
        scene.start();
        return scene;
    }

    stop(): void {
        try {
            this.scene?.stop();
        }
        finally {
            this.scene = undefined;
            this.engine.dispose();
        }
    }
}

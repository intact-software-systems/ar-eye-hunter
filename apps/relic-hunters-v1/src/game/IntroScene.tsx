import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js';
import { Scene } from '@babylonjs/core/scene.js';
import { useEffect, useRef, useState } from 'react';
import '@babylonjs/loaders/glTF/index.js';
import { AUTO_COMPLETE_MS, INTRO_DIALOGUE, pickSpeechVoice, type Lang } from './lang.ts';
import { createCastleExteriorScene, createWizardAmbientParticles, createWizardHost } from './scene/castleExterior.ts';

type IntroSceneProps = Readonly<{ onComplete: () => void; lang: Lang; }>;

export function IntroScene({ onComplete, lang }: IntroSceneProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [lineIndex, setLineIndex] = useState(-1);
    const [casting, setCasting] = useState(false);
    const [flash, setFlash] = useState(false);
    const [soundOn, setSoundOn] = useState(false);
    const soundOnRef = useRef(false);
    soundOnRef.current = soundOn;
    const castTriggerRef = useRef<(() => void) | null>(null);
    const completeRef = useRef(onComplete);
    completeRef.current = onComplete;
    const langRef = useRef(lang);
    langRef.current = lang;
    const voiceRef = useRef<SpeechSynthesisVoice | null>(null);

    // Load speech voice (voices may be async)
    useEffect(() => {
        if (!('speechSynthesis' in window)) {
            return;
        }
        const loadVoice = () => {
            voiceRef.current = pickSpeechVoice(langRef.current);
        };
        loadVoice();
        window.speechSynthesis.addEventListener('voiceschanged', loadVoice);
        return () => {
            window.speechSynthesis.removeEventListener('voiceschanged', loadVoice);
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // BabylonJS scene
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }

        const engine = new Engine(canvas, true, { antialias: true, stencil: true });
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0.03, 0.03, 0.055, 1);
        scene.ambientColor = new Color3(0.28, 0.26, 0.36);
        scene.fogMode = Scene.FOGMODE_EXP2;
        scene.fogColor = new Color3(0.04, 0.04, 0.07);
        scene.fogDensity = 0.007;

        // Camera — wide shot: wizard in foreground, castle looming behind
        const camState = {
            pos: new Vector3(1.8, 2.1, -8.5),
            look: new Vector3(-0.3, 3.2, 9)
        };
        const camera = new UniversalCamera('intro-cam', camState.pos.clone(), scene);
        camera.setTarget(camState.look.clone());
        camera.fov = 1.05;
        camera.minZ = 0.05;
        camera.maxZ = 130;

        // Moonlight
        const moon = new HemisphericLight('moon', new Vector3(-0.25, 1, 0.15), scene);
        moon.diffuse = new Color3(0.70, 0.72, 0.94);
        moon.groundColor = new Color3(0.10, 0.08, 0.16);
        moon.intensity = 0.85;

        // Wizard aura light
        const wizLight = new PointLight('wiz-light', new Vector3(0.3, 2.9, -1.4), scene);
        wizLight.diffuse = new Color3(0.96, 0.68, 0.18);
        wizLight.intensity = 1.3;
        wizLight.range = 9;

        // Lantern warmth along path
        const lanternLight = new PointLight('lantern-warm', new Vector3(0, 0.9, 2.5), scene);
        lanternLight.diffuse = new Color3(1.0, 0.74, 0.36);
        lanternLight.intensity = 0.38;
        lanternLight.range = 14;

        // Post-processing
        const pipeline = new DefaultRenderingPipeline('intro-pp', true, scene, [camera]);
        pipeline.bloomEnabled = true;
        pipeline.bloomThreshold = 0.65;
        pipeline.bloomWeight = 0.68;
        pipeline.bloomKernel = 80;
        pipeline.bloomScale = 0.5;
        pipeline.imageProcessingEnabled = true;
        pipeline.imageProcessing.contrast = 1.28;
        pipeline.imageProcessing.exposure = 0.90;

        const glow = new GlowLayer('intro-glow', scene);
        glow.intensity = 1.08;

        // Particle texture
        const sz = 32;
        const flameTex = new DynamicTexture('intro-flame-tex', { width: sz, height: sz }, scene, false);
        const ftx = flameTex.getContext() as CanvasRenderingContext2D;
        const half = sz / 2;
        const gr = ftx.createRadialGradient(half, half, 0, half, half, half);
        gr.addColorStop(0, 'rgba(255,248,200,1)');
        gr.addColorStop(0.35, 'rgba(255,165,40,0.85)');
        gr.addColorStop(0.7, 'rgba(255,60,0,0.45)');
        gr.addColorStop(1, 'rgba(180,20,0,0)');
        ftx.fillStyle = gr;
        ftx.fillRect(0, 0, sz, sz);
        flameTex.update();

        // Scene content (procedural + optional GLBs)
        const hostPos = new Vector3(0, 0.22, -1);
        let orbMaterialRef: { emissiveColor: { set(r: number, g: number, b: number): void; }; } | null = null;
        let staffOrbPos = new Vector3(
            0.52 + Math.sin(0.12) * 1.26,
            0.22 + (0.22 + 1.26 + Math.cos(0.12) * 1.26 + 0.46),
            -1.22
        );

        const buildProceduralCastle = () => {
            createCastleExteriorScene(scene);
        };
        const buildProceduralWizard = () => {
            const wiz = createWizardHost(scene);
            orbMaterialRef = wiz.orbMaterial as unknown as {
                emissiveColor: { set(r: number, g: number, b: number): void; };
            };
            staffOrbPos = wiz.staffOrbPos.add(hostPos);
            createWizardAmbientParticles(scene, hostPos, flameTex);
        };

        // Try GLBs, fall back gracefully
        Promise.allSettled([
            SceneLoader.ImportMeshAsync('', '/models/', 'castle-exterior.glb', scene),
            SceneLoader.ImportMeshAsync('', '/models/', 'host.glb', scene)
        ]).then(([castleRes, hostRes]) => {
            if (castleRes.status !== 'fulfilled' || castleRes.value.meshes.length === 0) {
                buildProceduralCastle();
            }
            else {
                castleRes.value.meshes[0]?.position.set(0, 0, 14);
            }
            if (hostRes.status !== 'fulfilled' || hostRes.value.meshes.length === 0) {
                buildProceduralWizard();
            }
            else {
                hostRes.value.meshes[0]?.position.copyFrom(hostPos);
                createWizardAmbientParticles(scene, hostPos, flameTex);
            }
        });

        // Cast spell effect
        const castDolly = { active: false, startT: 0 };
        const triggerCasting = () => {
            // Intensify orb rapidly
            let t = 0;
            const intensify = window.setInterval(() => {
                t = Math.min(1, t + 0.08);
                if (orbMaterialRef) {
                    const v = 0.92 + t * 2.2;
                    orbMaterialRef.emissiveColor = new Color3(1.0 * v, 0.55 * v, 0.09 * v) as unknown as {
                        set(r: number, g: number, b: number): void;
                    };
                }
                if (t >= 1) {
                    clearInterval(intensify);
                }
            }, 40);

            // Burst particles from staff orb
            const burstDefs = [
                { c1: new Color4(1.0, 0.88, 0.22, 1.0), c2: new Color4(1.0, 0.52, 0.08, 0.8), power: 2.8 },
                { c1: new Color4(0.58, 0.28, 1.0, 0.9), c2: new Color4(0.38, 0.18, 0.9, 0.7), power: 3.8 },
                { c1: new Color4(1.0, 1.0, 0.95, 0.95), c2: new Color4(0.9, 0.92, 1.0, 0.78), power: 4.8 }
            ];
            for (const [i, def] of burstDefs.entries()) {
                const sys = new ParticleSystem(`cast-ring-${i}`, 70, scene);
                sys.particleTexture = flameTex;
                sys.emitter = staffOrbPos.clone();
                sys.minEmitBox = new Vector3(-0.12, -0.12, -0.12);
                sys.maxEmitBox = new Vector3(0.12, 0.12, 0.12);
                sys.color1 = def.c1;
                sys.color2 = def.c2;
                sys.colorDead = new Color4(0.2, 0.08, 0.5, 0);
                sys.minSize = 0.1;
                sys.maxSize = 0.3;
                sys.minLifeTime = 0.7;
                sys.maxLifeTime = 1.8;
                sys.emitRate = 0;
                sys.manualEmitCount = 45 + i * 12;
                sys.direction1 = new Vector3(-2.8, 0.4, -2.8);
                sys.direction2 = new Vector3(2.8, 2.8, 2.8);
                sys.minEmitPower = def.power;
                sys.maxEmitPower = def.power + 1.8;
                sys.updateSpeed = 0.025;
                sys.gravity = new Vector3(0, 0.28, 0);
                sys.blendMode = ParticleSystem.BLENDMODE_ADD;
                window.setTimeout(() => sys.start(), i * 260);
            }

            // Dolly forward + flash
            castDolly.active = true;
            castDolly.startT = performance.now() / 1000;
            window.setTimeout(() => {
                setFlash(true);
                window.setTimeout(() => completeRef.current(), 700);
            }, 1700);
        };

        castTriggerRef.current = triggerCasting;

        // Render loop with camera drift
        let alive = true;
        engine.runRenderLoop(() => {
            if (!alive) {
                return;
            }
            const now = performance.now() / 1000;

            if (castDolly.active) {
                const progress = Math.min(1, (now - castDolly.startT) / 2.8);
                const ease = 1 - (1 - progress) * (1 - progress);
                const targetPos = new Vector3(0.4, 3.4, -3.0);
                const targetLook = new Vector3(0, 5.5, 16);
                camState.pos.addInPlace(targetPos.subtract(camState.pos).scale(ease * 0.06));
                camState.look.addInPlace(targetLook.subtract(camState.look).scale(ease * 0.06));
                // Bloom up during cast
                pipeline.bloomWeight = 0.68 + ease * 0.5;
                pipeline.imageProcessing.exposure = 0.9 + ease * 0.45;
            }
            else {
                // Slow cinematic drift
                const driftPos = new Vector3(
                    1.8 + Math.sin(now * 0.07) * 0.9,
                    2.1 + Math.sin(now * 0.11) * 0.22,
                    -8.5 + Math.sin(now * 0.06) * 0.7
                );
                const driftLook = new Vector3(
                    -0.3 + Math.sin(now * 0.05) * 0.4,
                    3.2 + Math.sin(now * 0.08) * 0.3,
                    9 + Math.sin(now * 0.09) * 1.5
                );
                camState.pos.addInPlace(driftPos.subtract(camState.pos).scale(0.011));
                camState.look.addInPlace(driftLook.subtract(camState.look).scale(0.011));
            }
            camera.position.copyFrom(camState.pos);
            camera.setTarget(camState.look);

            // Wizard light flicker
            wizLight.intensity = 1.3 + Math.sin(now * 2.6 + 0.4) * 0.18 + Math.sin(now * 7.1) * 0.08;

            scene.render();
        });

        const resize = () => engine.resize();
        window.addEventListener('resize', resize);
        return () => {
            alive = false;
            window.removeEventListener('resize', resize);
            scene.dispose();
            engine.dispose();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Dialogue timing + speech synthesis
    useEffect(() => {
        const dialogue = INTRO_DIALOGUE[langRef.current];
        const speechLang = langRef.current === 'no' ? 'nb-NO' : 'en-GB';
        const hasSpeech = 'speechSynthesis' in window;

        const speak = (text: string) => {
            if (!hasSpeech || text === '...' || !soundOnRef.current) {
                return;
            }
            window.speechSynthesis.cancel();
            const utter = new SpeechSynthesisUtterance(text);
            utter.lang = speechLang;
            utter.rate = 0.88;
            utter.pitch = 0.78;
            if (voiceRef.current) {
                utter.voice = voiceRef.current;
            }
            window.speechSynthesis.speak(utter);
        };

        const timers: number[] = [];
        for (const [index, line] of dialogue.entries()) {
            timers.push(window.setTimeout(() => {
                setLineIndex(index);
                speak(line.text);
                if (line.isCast) {
                    setCasting(true);
                    castTriggerRef.current?.();
                }
            }, line.delayMs));
        }
        timers.push(window.setTimeout(() => completeRef.current(), AUTO_COMPLETE_MS));
        return () => {
            timers.forEach(clearTimeout);
            if (hasSpeech) {
                window.speechSynthesis.cancel();
            }
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const dialogue = INTRO_DIALOGUE[lang];
    const currentText = lineIndex >= 0 ? dialogue[lineIndex]?.text ?? '' : '';

    return (
        <>
            <canvas ref={canvasRef} className="intro-scene-canvas" aria-hidden="true" tabIndex={-1} />
            <div className="intro-overlay" aria-live="polite">
                <div className="intro-host-label">The Arcane Keeper</div>
                <div className={`intro-dialogue-box${casting ? ' casting' : ''}`}>
                    {lineIndex >= 0 && (
                        <p key={lineIndex} className="intro-dialogue-text">
                            {currentText}
                        </p>
                    )}
                </div>
                <div className="intro-btn-row">
                    <button
                        type="button"
                        className={`intro-sound-btn${soundOn ? ' active' : ''}`}
                        onClick={() => setSoundOn((s) => !s)}
                    >
                        {soundOn ? 'Narrator: ON' : 'Narrator: OFF'}
                    </button>
                    <button
                        type="button"
                        className="intro-skip-btn"
                        onClick={() => {
                            if ('speechSynthesis' in window) {
                                window.speechSynthesis.cancel();
                            }
                            completeRef.current();
                        }}
                    >
                        Skip intro
                    </button>
                </div>
            </div>
            {flash && <div className="intro-flash" aria-hidden="true" />}
        </>
    );
}

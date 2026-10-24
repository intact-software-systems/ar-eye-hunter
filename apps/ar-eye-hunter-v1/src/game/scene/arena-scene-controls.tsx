import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type RefObject
} from 'react';
import {
    loadArenaAudioSettings,
    normalizeArenaAudioSettings,
    saveArenaAudioSettings,
    type ArenaAudioSettings
} from '../arenaAudio.ts';
import {
    createDefaultMobileControlSettings,
    loadMobileControlSettings,
    mapTouchLookDelta,
    normalizeMobileControlSettings,
    saveMobileControlSettings,
    type MobileControlSettings
} from '../mobileInput.ts';
import type { MutableButtonAction } from './arena-scene-contracts.ts';
import { forceUnlockArenaAudio } from './arena-scene-feedback.ts';
import type { ArenaSceneRuntime } from './arena-scene-runtime.ts';
import { applyLook } from './arena-scene-step.ts';
import { ArenaTouchInput, type ArenaStickView } from './arena-touch-input.ts';

interface ArenaSceneControlsState {
    readonly mobileSettings: MobileControlSettings;
    readonly audioSettings: ArenaAudioSettings;
    readonly updateMobileSettings: (patch: Partial<MobileControlSettings>) => void;
    readonly updateAudioSettings: (patch: Partial<ArenaAudioSettings>) => void;
    readonly stickView: ArenaStickView;
    readonly touchInput: ArenaTouchInput;
}
interface ArenaSceneControlsProps {
    readonly controls: ArenaSceneControlsState;
    readonly runtimeRef: RefObject<ArenaSceneRuntime | undefined>;
}
interface ArenaControlSliderProps {
    readonly label: string;
    readonly value: number;
    readonly min: number;
    readonly max: number;
    readonly step: number;
    readonly onChange: (value: number) => void;
}
interface ArenaControlCheckProps {
    readonly label: string;
    readonly checked: boolean;
    readonly onChange: (value: boolean) => void;
}
interface ArenaActionControlsProps {
    readonly input: ArenaTouchInput;
    readonly menuOpen: boolean;
    readonly toggleMenu: () => void;
}
const PULSE_ACTIONS: readonly MutableButtonAction[] = ['dash', 'jump', 'slide'];

export function useArenaSceneControls(
    runtimeRef: RefObject<ArenaSceneRuntime | undefined>,
    localColor: string
): ArenaSceneControlsState {
    const [mobileSettings, updateMobileSettings] = useMobilePreferences(runtimeRef);
    const [audioSettings, updateAudioSettings] = useAudioPreferences(runtimeRef);
    const [stickView, setStickView] = useState<ArenaStickView>({ active: false, knobX: 0, knobY: 0 });
    const touchInput = useMemo(() => new ArenaTouchInput({ runtimeRef, onStickChange: setStickView, localColor }), [
        runtimeRef,
        localColor
    ]);
    useGyroInput(runtimeRef, mobileSettings.gyroEnabled);
    return { mobileSettings, updateMobileSettings, audioSettings, updateAudioSettings, stickView, touchInput };
}

function useMobilePreferences(runtimeRef: RefObject<ArenaSceneRuntime | undefined>) {
    const [settings, setSettings] = useState(() =>
        typeof window === 'undefined'
            ? createDefaultMobileControlSettings()
            : loadMobileControlSettings((key) => window.localStorage.getItem(key))
    );
    useEffect(() => {
        const runtime = runtimeRef.current;
        if (runtime) {
            runtime.mobileSettings = settings;
            runtime.inputDevice = settings.gyroEnabled && runtime.inputDevice === 'touch'
                ? 'gyro-touch'
                : runtime.inputDevice;
        }
    }, [runtimeRef, settings]);
    const update = (patch: Partial<MobileControlSettings>) => {
        setSettings((current) => {
            const next = normalizeMobileControlSettings({ ...current, ...patch });
            saveMobileControlSettings(next, (key, value) => window.localStorage.setItem(key, value));
            return next;
        });
    };
    return [settings, update] as const;
}

function useAudioPreferences(runtimeRef: RefObject<ArenaSceneRuntime | undefined>) {
    const [settings, setSettings] = useState(() =>
        typeof window === 'undefined'
            ? normalizeArenaAudioSettings({})
            : loadArenaAudioSettings((key) => window.localStorage.getItem(key))
    );
    useEffect(() => {
        const runtime = runtimeRef.current;
        if (runtime) {
            runtime.audioSettings = settings;
            runtime.audio.updateSettings(settings);
        }
    }, [runtimeRef, settings]);
    const update = (patch: Partial<ArenaAudioSettings>) => {
        setSettings((current) => {
            const next = normalizeArenaAudioSettings({ ...current, ...patch });
            saveArenaAudioSettings(next, (key, value) => window.localStorage.setItem(key, value));
            return next;
        });
    };
    return [settings, update] as const;
}

function useGyroInput(runtimeRef: RefObject<ArenaSceneRuntime | undefined>, enabled: boolean): void {
    const previousRef = useRef<{ readonly beta: number; readonly gamma: number; } | undefined>(undefined);
    useEffect(() => {
        if (!enabled) {
            previousRef.current = undefined;
            return;
        }
        const onOrientation = (event: DeviceOrientationEvent) => {
            const runtime = runtimeRef.current;
            if (!runtime || typeof event.beta !== 'number' || typeof event.gamma !== 'number') {
                return;
            }
            const previous = previousRef.current;
            previousRef.current = { beta: event.beta, gamma: event.gamma };
            if (!previous) {
                return;
            }
            const delta = mapTouchLookDelta(
                (event.gamma - previous.gamma) * 2.1,
                (event.beta - previous.beta) * 1.45,
                runtime.mobileSettings
            );
            applyLook(runtime, delta.yawDelta, delta.pitchDelta);
            runtime.inputDevice = 'gyro-touch';
        };
        window.addEventListener('deviceorientation', onOrientation);
        return () => window.removeEventListener('deviceorientation', onOrientation);
    }, [runtimeRef, enabled]);
}

async function enableGyro(update: ArenaSceneControlsState['updateMobileSettings']): Promise<void> {
    const orientation = globalThis.DeviceOrientationEvent as typeof DeviceOrientationEvent & {
        requestPermission?: () => Promise<string>;
    };
    try {
        const permission = await orientation?.requestPermission?.();
        update({ gyroEnabled: permission === undefined || permission === 'granted' });
    }
    catch {
        update({ gyroEnabled: false });
    }
}

export function ArenaSceneControls({ controls, runtimeRef }: ArenaSceneControlsProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const style = { '--mobile-button-scale': controls.mobileSettings.buttonScale } as CSSProperties;
    return (
        <>
            <div className="mobile-fps-controls" style={style} aria-label="Mobile FPS controls">
                <ArenaMovementControls controls={controls} />
                <ArenaActionControls
                    input={controls.touchInput}
                    menuOpen={menuOpen}
                    toggleMenu={() => setMenuOpen((open) => !open)}
                />
                {menuOpen && <ArenaControlSettings controls={controls} />}
            </div>
            <div className="arena-audio-controls" aria-label="Arena audio">
                <button
                    type="button"
                    onClick={() => {
                        const runtime = runtimeRef.current;
                        if (runtime) {
                            forceUnlockArenaAudio(runtime);
                            if (!runtime.audio.isUnlocked() && !controls.audioSettings.muted) {
                                return;
                            }
                        }
                        controls.updateAudioSettings({ muted: !controls.audioSettings.muted });
                    }}
                >
                    {controls.audioSettings.muted ? 'Audio Off' : 'Audio On'}
                </button>
            </div>
        </>
    );
}

function ArenaMovementControls({ controls }: Pick<ArenaSceneControlsProps, 'controls'>) {
    const { touchInput: input, stickView } = controls;
    return (
        <>
            <div
                className="mobile-stick-zone"
                data-active={stickView.active ? 'true' : 'false'}
                aria-label="Move and sprint"
                onPointerDown={input.onMovePointerDown}
                onPointerMove={input.onMovePointerMove}
                onPointerUp={input.releasePointer}
                onPointerCancel={input.releasePointer}
                onLostPointerCapture={input.releasePointer}
            >
                <span className="mobile-stick-ring">
                    <span
                        className="mobile-stick-knob"
                        style={{ transform: `translate(${stickView.knobX}px, ${stickView.knobY}px)` }}
                    />
                </span>
                <span className="mobile-stick-label">MOVE / SPRINT</span>
            </div>
            <div
                className="mobile-look-zone"
                aria-label="Look and aim"
                onPointerDown={input.onLookPointerDown}
                onPointerMove={input.onLookPointerMove}
                onPointerUp={input.releasePointer}
                onPointerCancel={input.releasePointer}
                onLostPointerCapture={input.releasePointer}
            >
                <span>LOOK</span>
            </div>
        </>
    );
}

interface ArenaHeldActionProps {
    readonly input: ArenaTouchInput;
    readonly action: 'fire' | 'altFire' | 'overdrive';
    readonly label: string;
}
function ArenaActionControls({ input, menuOpen, toggleMenu }: ArenaActionControlsProps) {
    return (
        <div className="mobile-action-cluster" aria-label="Combat actions">
            <ArenaHeldAction input={input} action="fire" label="Fire" />
            <ArenaHeldAction input={input} action="altFire" label="Scan" />
            {PULSE_ACTIONS.map((action) => (
                <button
                    key={action}
                    type="button"
                    className="mobile-action"
                    onPointerDown={(event) => input.onActionDown(event, action, 'pulse')}
                >
                    {action[0].toUpperCase() + action.slice(1)}
                </button>
            ))}
            <ArenaHeldAction input={input} action="overdrive" label="OD" />
            <button
                type="button"
                className="mobile-action mobile-action--settings"
                aria-expanded={menuOpen}
                onClick={toggleMenu}
            >
                Tune
            </button>
        </div>
    );
}
function ArenaHeldAction({ input, action, label }: ArenaHeldActionProps) {
    return (
        <button
            type="button"
            className={action === 'fire' ? 'mobile-action mobile-action--fire' : 'mobile-action'}
            onPointerDown={(event) =>
                action === 'altFire' ? input.onScanDown(event) : input.onActionDown(event, action, 'hold')}
            onPointerUp={(event) => input.onActionUp(event, action, 'hold')}
            onPointerCancel={(event) => input.onActionUp(event, action, 'hold')}
            onLostPointerCapture={(event) => input.onActionUp(event, action, 'hold')}
        >
            {label}
        </button>
    );
}

function ArenaControlSettings({ controls }: Pick<ArenaSceneControlsProps, 'controls'>) {
    return (
        <div className="mobile-settings-panel">
            <div>
                <strong>Mobile Controls</strong>
                <span>Landscape dual-stick audit mode</span>
            </div>
            <ArenaMobilePreferences controls={controls} />
            <ArenaAudioPreferences controls={controls} />
        </div>
    );
}
function ArenaMobilePreferences({ controls }: Pick<ArenaSceneControlsProps, 'controls'>) {
    const { mobileSettings: mobile, updateMobileSettings: updateMobile } = controls;
    return (
        <>
            <ArenaControlSlider
                label="Sensitivity"
                value={mobile.touchSensitivity}
                min={0.35}
                max={2.4}
                step={0.05}
                onChange={(touchSensitivity) => updateMobile({ touchSensitivity })}
            />
            <ArenaControlSlider
                label="Button scale"
                value={mobile.buttonScale}
                min={0.72}
                max={1.35}
                step={0.03}
                onChange={(buttonScale) => updateMobile({ buttonScale })}
            />
            <ArenaControlCheck
                label="Invert look Y"
                checked={mobile.invertY}
                onChange={(invertY) => updateMobile({ invertY })}
            />
            <ArenaControlCheck
                label="Haptics"
                checked={mobile.hapticsEnabled}
                onChange={(hapticsEnabled) => updateMobile({ hapticsEnabled })}
            />
            <button
                type="button"
                className={mobile.gyroEnabled ? 'mobile-gyro active' : 'mobile-gyro'}
                onClick={() => {
                    if (mobile.gyroEnabled) {
                        updateMobile({ gyroEnabled: false });
                    }
                    else {
                        void enableGyro(updateMobile);
                    }
                }}
            >
                {mobile.gyroEnabled ? 'Gyro fine-aim on' : 'Enable gyro fine-aim'}
            </button>
        </>
    );
}
function ArenaAudioPreferences({ controls }: Pick<ArenaSceneControlsProps, 'controls'>) {
    const { audioSettings: audio, updateAudioSettings: updateAudio } = controls;
    return (
        <>
            <ArenaControlSlider
                label="Score"
                value={audio.musicVolume}
                min={0}
                max={0.24}
                step={0.01}
                onChange={(musicVolume) => updateAudio({ musicVolume })}
            />
            <ArenaControlSlider
                label="SFX"
                value={audio.sfxVolume}
                min={0}
                max={0.6}
                step={0.02}
                onChange={(sfxVolume) => updateAudio({ sfxVolume })}
            />
            <ArenaControlCheck
                label="Reduced audio intensity"
                checked={audio.reducedIntensity}
                onChange={(reducedIntensity) => updateAudio({ reducedIntensity })}
            />
            <ArenaControlCheck
                label="Auto-start subtle score"
                checked={audio.autoStartOnGesture}
                onChange={(autoStartOnGesture) => updateAudio({ autoStartOnGesture })}
            />
        </>
    );
}

function ArenaControlSlider({ label, value, min, max, step, onChange }: ArenaControlSliderProps) {
    return (
        <label>
            {label}
            <input
                type="range"
                value={value}
                min={min}
                max={max}
                step={step}
                onChange={(event) => onChange(Number(event.currentTarget.value))}
            />
        </label>
    );
}

function ArenaControlCheck({ label, checked, onChange }: ArenaControlCheckProps) {
    return (
        <label className="mobile-setting-check">
            <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
            {label}
        </label>
    );
}

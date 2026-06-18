import type { WeaponKind } from './types.ts';
import type { ArenaLinkTone } from './squadLink.ts';

export type ArenaAudioSettings = Readonly<{
    masterVolume: number;
    musicVolume: number;
    sfxVolume: number;
    eyeDroneVolume: number;
    muted: boolean;
    reducedIntensity: boolean;
    autoStartOnGesture: boolean;
}>;

export type ArenaAudioEvent =
    | Readonly<{ kind: 'shot'; weaponKind: WeaponKind }>
    | Readonly<{
        kind:
            | 'hit'
            | 'damage'
            | 'pickup'
            | 'respawn'
            | 'link-joined'
            | 'link-left'
            | 'sync'
            | 'match-start'
            | 'match-end'
            | 'wave-start'
            | 'wave-complete'
            | 'low-health-warning';
    }>
    | Readonly<{ kind: 'eye-drone'; threatCount: number; distanceFactor?: number }>;

export type ArenaAudioEffectiveLevels = Readonly<{
    music: number;
    shot: number;
    eyeDrone: number;
}>;

export type ArenaMusicInput = Readonly<{
    matchStatus: 'infinite' | 'active' | 'complete';
    matchRemainingRatio: number;
    wavePhase: 'warmup' | 'active' | 'reward';
    waveNumber: number;
    hostileCount: number;
    incomingAttack: boolean;
    healthRatio: number;
    linkTone: ArenaLinkTone;
    reducedIntensity: boolean;
}>;

export type ArenaMusicLayerState = Readonly<{
    baseHum: number;
    pulseBass: number;
    threatDrone: number;
    matchClock: number;
    lowHealth: number;
    rewardShimmer: number;
    linkStatic: number;
    intensity: number;
}>;

export type ArenaAudioDiagnostics = Readonly<{
    unlocked: boolean;
    contextState: AudioContextState | 'unavailable';
    muted: boolean;
    activeVoices: number;
    musicLayer: string;
    musicIntensity: number;
}>;

export const ARENA_AUDIO_STORAGE_KEY = 'ar-eye-hunter.audio.v2';

const DEFAULT_ARENA_AUDIO_SETTINGS: ArenaAudioSettings = {
    masterVolume: 0.34,
    musicVolume: 0.2,
    sfxVolume: 0.54,
    eyeDroneVolume: 0.16,
    muted: false,
    reducedIntensity: false,
    autoStartOnGesture: true,
};

const MUSIC_OSCILLATOR_GAIN = 0.056;
const SHOT_PEAK_GAIN = 0.52;
const EYE_DRONE_PEAK_GAIN = 0.026;
const ARENA_MUSIC_LAYER_KEYS = [
    'baseHum',
    'pulseBass',
    'threatDrone',
    'matchClock',
    'lowHealth',
    'rewardShimmer',
    'linkStatic',
] as const;
type ArenaMusicLayerKey = typeof ARENA_MUSIC_LAYER_KEYS[number];
const ZERO_MUSIC_LAYER_STATE: ArenaMusicLayerState = {
    baseHum: 0,
    pulseBass: 0,
    threatDrone: 0,
    matchClock: 0,
    lowHealth: 0,
    rewardShimmer: 0,
    linkStatic: 0,
    intensity: 0,
};

export function createDefaultArenaAudioSettings(): ArenaAudioSettings {
    return DEFAULT_ARENA_AUDIO_SETTINGS;
}

export function normalizeArenaAudioSettings(
    value: Partial<ArenaAudioSettings>,
): ArenaAudioSettings {
    return {
        masterVolume: clampVolume(value.masterVolume, DEFAULT_ARENA_AUDIO_SETTINGS.masterVolume),
        musicVolume: clampVolume(value.musicVolume, DEFAULT_ARENA_AUDIO_SETTINGS.musicVolume),
        sfxVolume: clampVolume(value.sfxVolume, DEFAULT_ARENA_AUDIO_SETTINGS.sfxVolume),
        eyeDroneVolume: clampVolume(value.eyeDroneVolume, DEFAULT_ARENA_AUDIO_SETTINGS.eyeDroneVolume),
        muted: Boolean(value.muted),
        reducedIntensity: Boolean(value.reducedIntensity),
        autoStartOnGesture: typeof value.autoStartOnGesture === 'boolean'
            ? value.autoStartOnGesture
            : DEFAULT_ARENA_AUDIO_SETTINGS.autoStartOnGesture,
    };
}

export function loadArenaAudioSettings(
    read: (key: string) => string | null,
): ArenaAudioSettings {
    const raw = read(ARENA_AUDIO_STORAGE_KEY);
    if (!raw) {
        return createDefaultArenaAudioSettings();
    }
    try {
        return normalizeArenaAudioSettings(JSON.parse(raw) as Partial<ArenaAudioSettings>);
    } catch {
        return createDefaultArenaAudioSettings();
    }
}

export function saveArenaAudioSettings(
    settings: ArenaAudioSettings,
    write: (key: string, value: string) => void,
): void {
    write(ARENA_AUDIO_STORAGE_KEY, JSON.stringify(normalizeArenaAudioSettings(settings)));
}

export function shouldPlayArenaAudioVoice(
    settings: ArenaAudioSettings,
    activeVoices: number,
    maxVoices: number,
): boolean {
    return !settings.muted &&
        settings.masterVolume > 0 &&
        activeVoices < maxVoices;
}

export function calculateArenaAudioEffectiveLevels(
    settings: ArenaAudioSettings,
): ArenaAudioEffectiveLevels {
    const normalized = normalizeArenaAudioSettings(settings);
    const master = normalized.muted ? 0 : normalized.masterVolume;
    return {
        music: round4(master * normalized.musicVolume * MUSIC_OSCILLATOR_GAIN),
        shot: round4(master * normalized.sfxVolume * SHOT_PEAK_GAIN),
        eyeDrone: round4(master * normalized.eyeDroneVolume * EYE_DRONE_PEAK_GAIN),
    };
}

export function calculateArenaMusicLayerState(
    input: ArenaMusicInput,
    settings: ArenaAudioSettings,
): ArenaMusicLayerState {
    const normalized = normalizeArenaAudioSettings(settings);
    const master = normalized.muted ? 0 : normalized.masterVolume;
    const musicBase = master * normalized.musicVolume;
    if (musicBase <= 0) {
        return ZERO_MUSIC_LAYER_STATE;
    }

    const reduced = input.reducedIntensity || normalized.reducedIntensity;
    const intensityScale = reduced ? 0.52 : 1;
    const matchPressure = input.matchStatus === 'active'
        ? clamp01(1 - input.matchRemainingRatio)
        : 0;
    const wavePressure = clamp01((input.waveNumber - 1) / 12);
    const threatPressure = clamp01(input.hostileCount / 8 + (input.incomingAttack ? 0.35 : 0));
    const lowHealthPressure = clamp01((0.45 - input.healthRatio) / 0.45);
    const linkPressure = input.linkTone === 'degraded' || input.linkTone === 'rejoining'
        ? 1
        : input.linkTone === 'forming'
        ? 0.45
        : 0;
    const reward = input.wavePhase === 'reward' || input.matchStatus === 'complete' ? 1 : 0;

    const state: ArenaMusicLayerState = {
        baseHum: round4(musicBase * 0.22 * intensityScale),
        pulseBass: round4(musicBase * (0.03 + 0.11 * Math.max(matchPressure, wavePressure)) * intensityScale),
        threatDrone: round4(musicBase * (0.015 + 0.16 * threatPressure) * intensityScale),
        matchClock: round4(musicBase * 0.14 * matchPressure * intensityScale),
        lowHealth: round4(musicBase * 0.18 * lowHealthPressure * intensityScale),
        rewardShimmer: round4(musicBase * 0.13 * reward * intensityScale),
        linkStatic: round4(musicBase * 0.08 * linkPressure * intensityScale),
        intensity: 0,
    };

    return {
        ...state,
        intensity: round4(Math.min(1, (
            state.baseHum +
            state.pulseBass +
            state.threatDrone +
            state.matchClock +
            state.lowHealth +
            state.rewardShimmer +
            state.linkStatic
        ) / Math.max(0.001, musicBase * 0.78))),
    };
}

export class ProceduralArenaAudio {
    private context?: AudioContext;
    private master?: GainNode;
    private musicGain?: GainNode;
    private sfxGain?: GainNode;
    private eyeGain?: GainNode;
    private musicOscillators: OscillatorNode[] = [];
    private musicLayerGains?: Record<ArenaMusicLayerKey, GainNode>;
    private musicLayerState = ZERO_MUSIC_LAYER_STATE;
    private activeVoices = 0;
    private lastDroneAtMs = 0;

    constructor(
        private settings: ArenaAudioSettings = createDefaultArenaAudioSettings(),
        private readonly maxVoices = 10,
    ) {}

    updateSettings(settings: ArenaAudioSettings): void {
        this.settings = normalizeArenaAudioSettings(settings);
        this.applyGainSettings();
    }

    isUnlocked(): boolean {
        return Boolean(this.context);
    }

    diagnostics(): ArenaAudioDiagnostics {
        return {
            unlocked: Boolean(this.context),
            contextState: this.context?.state ?? 'unavailable',
            muted: this.settings.muted,
            activeVoices: this.activeVoices,
            musicLayer: readDominantMusicLayer(this.musicLayerState),
            musicIntensity: this.musicLayerState.intensity,
        };
    }

    async unlock(): Promise<void> {
        if (this.context) {
            if (this.context.state === 'suspended') {
                await this.context.resume();
            }
            return;
        }
        const AudioCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        if (!AudioCtor) {
            return;
        }
        const context = new AudioCtor();
        const master = context.createGain();
        const musicGain = context.createGain();
        const sfxGain = context.createGain();
        const eyeGain = context.createGain();
        musicGain.connect(master);
        sfxGain.connect(master);
        eyeGain.connect(master);
        master.connect(context.destination);
        this.context = context;
        this.master = master;
        this.musicGain = musicGain;
        this.sfxGain = sfxGain;
        this.eyeGain = eyeGain;
        this.applyGainSettings();
        this.startAdaptiveScore();
        if (context.state === 'suspended') {
            await context.resume();
        }
    }

    play(event: ArenaAudioEvent): void {
        if (!this.context || !shouldPlayArenaAudioVoice(this.settings, this.activeVoices, this.maxVoices)) {
            return;
        }
        if (event.kind === 'shot') {
            this.playShot(event.weaponKind);
            return;
        }
        if (event.kind === 'eye-drone') {
            this.pulseEyeDrone(event.threatCount, event.distanceFactor ?? 1);
            return;
        }
        this.playUiPulse(event.kind);
    }

    updateMusic(input: ArenaMusicInput): ArenaMusicLayerState {
        this.musicLayerState = calculateArenaMusicLayerState(input, this.settings);
        this.applyMusicLayerState();
        return this.musicLayerState;
    }

    dispose(): void {
        for (const oscillator of this.musicOscillators) {
            oscillator.stop();
            oscillator.disconnect();
        }
        this.musicOscillators = [];
        void this.context?.close();
        this.context = undefined;
    }

    private applyGainSettings(): void {
        const now = this.context?.currentTime ?? 0;
        const masterVolume = this.settings.muted ? 0 : this.settings.masterVolume;
        this.master?.gain.setTargetAtTime(masterVolume, now, 0.035);
        this.musicGain?.gain.setTargetAtTime(this.settings.musicVolume, now, 0.08);
        this.sfxGain?.gain.setTargetAtTime(this.settings.sfxVolume, now, 0.02);
        this.eyeGain?.gain.setTargetAtTime(this.settings.eyeDroneVolume, now, 0.06);
        this.applyMusicLayerState();
    }

    private startAdaptiveScore(): void {
        const context = this.context;
        const musicGain = this.musicGain;
        if (!context || !musicGain || this.musicOscillators.length > 0) {
            return;
        }
        const layers = Object.fromEntries(
            ARENA_MUSIC_LAYER_KEYS.map((key) => [key, context.createGain()]),
        ) as Record<ArenaMusicLayerKey, GainNode>;
        this.musicLayerGains = layers;
        createLoopingTone(context, layers.baseHum, [
            [55, -9, 'sine'],
            [82.4, 7, 'sine'],
            [110, 3, 'sine'],
        ], this.musicOscillators);
        createLoopingTone(context, layers.pulseBass, [[38, -2, 'triangle']], this.musicOscillators);
        createLoopingTone(context, layers.threatDrone, [[72, 5, 'sawtooth']], this.musicOscillators);
        createLoopingTone(context, layers.matchClock, [[184, 0, 'square']], this.musicOscillators);
        createLoopingTone(context, layers.lowHealth, [[222, -12, 'sine']], this.musicOscillators);
        createLoopingTone(context, layers.rewardShimmer, [[660, 9, 'triangle']], this.musicOscillators);
        createLoopingTone(context, layers.linkStatic, [[48, 0, 'square']], this.musicOscillators);
        for (const gain of Object.values(layers)) {
            gain.gain.value = 0;
            gain.connect(musicGain);
        }
        this.applyMusicLayerState();
    }

    private applyMusicLayerState(): void {
        const context = this.context;
        const layers = this.musicLayerGains;
        if (!context || !layers) {
            return;
        }
        const now = context.currentTime;
        for (const key of ARENA_MUSIC_LAYER_KEYS) {
            layers[key].gain.setTargetAtTime(this.musicLayerState[key], now, 0.22);
        }
    }

    private playShot(weaponKind: WeaponKind): void {
        const context = this.context;
        const sfxGain = this.sfxGain;
        if (!context || !sfxGain) {
            return;
        }
        const now = context.currentTime;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const filter = context.createBiquadFilter();
        const base = weaponKind === 'rail-lance'
            ? 740
            : weaponKind === 'spread-shot' || weaponKind === 'confetti-cannon'
            ? 420
            : weaponKind === 'audit-pea-shooter'
            ? 520
            : 620;
        oscillator.type = weaponKind === 'glitch-blaster' ? 'square' : 'sawtooth';
        oscillator.frequency.setValueAtTime(base * 1.7, now);
        oscillator.frequency.exponentialRampToValueAtTime(Math.max(80, base * 0.42), now + 0.11);
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(base * 2.2, now);
        filter.Q.value = 8;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(SHOT_PEAK_GAIN, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
        oscillator.connect(filter);
        filter.connect(gain);
        gain.connect(sfxGain);
        this.startTransientVoice(oscillator, now, 0.16);
    }

    private pulseEyeDrone(threatCount: number, distanceFactor: number): void {
        const context = this.context;
        const eyeGain = this.eyeGain;
        const nowMs = performance.now();
        if (!context || !eyeGain || threatCount <= 0 || nowMs - this.lastDroneAtMs < 360) {
            return;
        }
        this.lastDroneAtMs = nowMs;
        const now = context.currentTime;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'triangle';
        oscillator.frequency.value = 24 + Math.min(20, threatCount * 2.5);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(
            Math.max(0.006, Math.min(0.05, EYE_DRONE_PEAK_GAIN * distanceFactor)),
            now + 0.04,
        );
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
        oscillator.connect(gain);
        gain.connect(eyeGain);
        this.startTransientVoice(oscillator, now, 0.32);
    }

    private playUiPulse(kind: Exclude<ArenaAudioEvent['kind'], 'shot' | 'eye-drone'>): void {
        const context = this.context;
        const sfxGain = this.sfxGain;
        if (!context || !sfxGain) {
            return;
        }
        const now = context.currentTime;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const tone = readUiPulseTone(kind);
        oscillator.type = tone.type;
        oscillator.frequency.value = tone.frequency;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(tone.gain, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.duration);
        oscillator.connect(gain);
        gain.connect(sfxGain);
        this.startTransientVoice(oscillator, now, tone.duration + 0.04);
    }

    private startTransientVoice(
        oscillator: OscillatorNode,
        now: number,
        durationSeconds: number,
    ): void {
        this.activeVoices += 1;
        oscillator.start(now);
        oscillator.stop(now + durationSeconds);
        oscillator.addEventListener('ended', () => {
            oscillator.disconnect();
            this.activeVoices = Math.max(0, this.activeVoices - 1);
        }, { once: true });
    }
}

function clampVolume(value: unknown, fallback: number): number {
    return round3(Math.min(1, Math.max(0, typeof value === 'number' ? value : fallback)));
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

function round4(value: number): number {
    return Math.round(value * 10000) / 10000;
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function readDominantMusicLayer(state: ArenaMusicLayerState): string {
    let strongest: ArenaMusicLayerKey = 'baseHum';
    for (const key of ARENA_MUSIC_LAYER_KEYS) {
        if (state[key] > state[strongest]) {
            strongest = key;
        }
    }
    return state[strongest] > 0 ? strongest : 'silent';
}

function createLoopingTone(
    context: AudioContext,
    destination: GainNode,
    tones: readonly (readonly [number, number, OscillatorType])[],
    registry: OscillatorNode[],
): void {
    for (const [frequency, detune, type] of tones) {
        const oscillator = context.createOscillator();
        oscillator.type = type;
        oscillator.frequency.value = frequency;
        oscillator.detune.value = detune;
        oscillator.connect(destination);
        oscillator.start();
        registry.push(oscillator);
    }
}

function readUiPulseTone(
    kind: Exclude<ArenaAudioEvent['kind'], 'shot' | 'eye-drone'>,
): Readonly<{
    frequency: number;
    gain: number;
    duration: number;
    type: OscillatorType;
}> {
    switch (kind) {
        case 'damage':
        case 'low-health-warning':
            return { frequency: 120, gain: 0.2, duration: 0.2, type: 'sawtooth' };
        case 'pickup':
        case 'wave-complete':
            return { frequency: 880, gain: 0.14, duration: 0.18, type: 'triangle' };
        case 'respawn':
            return { frequency: 360, gain: 0.13, duration: 0.24, type: 'sine' };
        case 'link-joined':
        case 'sync':
            return { frequency: 520, gain: 0.08, duration: 0.14, type: 'sine' };
        case 'link-left':
            return { frequency: 170, gain: 0.08, duration: 0.22, type: 'triangle' };
        case 'match-start':
        case 'wave-start':
            return { frequency: 440, gain: 0.12, duration: 0.2, type: 'square' };
        case 'match-end':
            return { frequency: 620, gain: 0.12, duration: 0.28, type: 'triangle' };
        case 'hit':
        default:
            return { frequency: 260, gain: 0.12, duration: 0.18, type: 'sine' };
    }
}

declare global {
    // Safari exposes webkitAudioContext.
    // eslint-disable-next-line no-var
    var webkitAudioContext: typeof AudioContext | undefined;
}

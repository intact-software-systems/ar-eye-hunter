import type { WeaponKind } from './types.ts';

export type ArenaAudioSettings = Readonly<{
    masterVolume: number;
    musicVolume: number;
    sfxVolume: number;
    eyeDroneVolume: number;
    muted: boolean;
    reducedIntensity: boolean;
}>;

export type ArenaAudioEvent =
    | Readonly<{ kind: 'shot'; weaponKind: WeaponKind }>
    | Readonly<{ kind: 'hit' | 'damage' | 'pickup' | 'respawn' }>
    | Readonly<{ kind: 'eye-drone'; threatCount: number; distanceFactor?: number }>;

export const ARENA_AUDIO_STORAGE_KEY = 'ar-eye-hunter.audio.v1';

const DEFAULT_ARENA_AUDIO_SETTINGS: ArenaAudioSettings = {
    masterVolume: 0.18,
    musicVolume: 0.1,
    sfxVolume: 0.28,
    eyeDroneVolume: 0.055,
    muted: false,
    reducedIntensity: false,
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

export class ProceduralArenaAudio {
    private context?: AudioContext;
    private master?: GainNode;
    private musicGain?: GainNode;
    private sfxGain?: GainNode;
    private eyeGain?: GainNode;
    private musicOscillators: OscillatorNode[] = [];
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
        this.startEerieScore();
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
    }

    private startEerieScore(): void {
        const context = this.context;
        const musicGain = this.musicGain;
        if (!context || !musicGain || this.musicOscillators.length > 0) {
            return;
        }
        for (const [frequency, detune] of [[55, -9], [82.4, 7], [110, 3]] as const) {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = 'sine';
            oscillator.frequency.value = frequency;
            oscillator.detune.value = detune;
            gain.gain.value = this.settings.reducedIntensity ? 0.015 : 0.028;
            oscillator.connect(gain);
            gain.connect(musicGain);
            oscillator.start();
            this.musicOscillators.push(oscillator);
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
        gain.gain.exponentialRampToValueAtTime(0.34, now + 0.008);
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
            Math.max(0.004, Math.min(0.04, 0.012 * distanceFactor)),
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
        oscillator.type = 'sine';
        oscillator.frequency.value = kind === 'damage' ? 120 : kind === 'pickup' ? 880 : 260;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(kind === 'damage' ? 0.2 : 0.12, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
        oscillator.connect(gain);
        gain.connect(sfxGain);
        this.startTransientVoice(oscillator, now, 0.22);
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

declare global {
    // Safari exposes webkitAudioContext.
    // eslint-disable-next-line no-var
    var webkitAudioContext: typeof AudioContext | undefined;
}

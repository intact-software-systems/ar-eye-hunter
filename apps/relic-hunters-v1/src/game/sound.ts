import type { RelicActionKind, RelicEvent } from '@relic-hunters/mod.ts';

type UiSound = 'join' | 'start' | 'submit' | 'reset' | 'select';

let audioContext: AudioContext | undefined;
type AmbientDrone = Readonly<{
    oscillator: OscillatorNode;
    gain: GainNode;
    lfo: OscillatorNode;
    lfoGain: GainNode;
}>;
let ambientSound: Readonly<{
    master: GainNode;
    drones: readonly AmbientDrone[];
    chimeTimer: number;
}> | undefined;

export function playUiSound(sound: UiSound): void {
    const ctx = ensureAudioContext();
    if (!ctx) {
        return;
    }

    switch (sound) {
        case 'join':
            playTone(ctx, 392, 0.06, 'sine', 0.055);
            playTone(ctx, 587, 0.09, 'triangle', 0.045, 0.05);
            break;
        case 'start':
            playTone(ctx, 196, 0.08, 'sawtooth', 0.045);
            playTone(ctx, 392, 0.13, 'triangle', 0.055, 0.08);
            break;
        case 'submit':
            playTone(ctx, 146, 0.055, 'square', 0.045);
            playTone(ctx, 220, 0.08, 'triangle', 0.035, 0.055);
            break;
        case 'reset':
            playNoise(ctx, 0.11, 0.035, 480);
            break;
        case 'select':
            playTone(ctx, 520, 0.035, 'sine', 0.025);
            break;
    }
}

export function playActionSound(action: RelicActionKind): void {
    const ctx = ensureAudioContext();
    if (!ctx) {
        return;
    }

    switch (action) {
        case 'move':
            playTone(ctx, 330, 0.06, 'triangle', 0.04);
            playTone(ctx, 440, 0.08, 'sine', 0.035, 0.05);
            break;
        case 'search':
            playTone(ctx, 622, 0.08, 'sine', 0.04);
            playTone(ctx, 932, 0.11, 'triangle', 0.035, 0.06);
            break;
        case 'steal':
            playTone(ctx, 170, 0.07, 'sawtooth', 0.04);
            playTone(ctx, 130, 0.08, 'square', 0.03, 0.05);
            break;
        case 'escape':
            playTone(ctx, 392, 0.08, 'triangle', 0.05);
            playTone(ctx, 784, 0.14, 'sine', 0.045, 0.08);
            break;
    }
}

export function playRelicEventSound(event: RelicEvent): void {
    const ctx = ensureAudioContext();
    if (!ctx) {
        return;
    }

    switch (event.type) {
        case 'player_joined':
            playUiSound('join');
            break;
        case 'round_started':
            playTone(ctx, 246, 0.08, 'triangle', 0.04);
            playTone(ctx, 369, 0.09, 'sine', 0.035, 0.08);
            break;
        case 'action_revealed':
            playTone(ctx, 185, 0.12, 'sawtooth', 0.035);
            break;
        case 'player_moved':
            playActionSound('move');
            break;
        case 'player_searched':
            playActionSound('search');
            break;
        case 'relic_found':
        case 'relic_picked_up':
            playTone(ctx, 659, 0.12, 'sine', 0.05);
            playTone(ctx, 988, 0.16, 'triangle', 0.04, 0.08);
            playTone(ctx, 1318, 0.18, 'sine', 0.035, 0.15);
            break;
        case 'steal_succeeded':
        case 'steal_failed':
            playActionSound('steal');
            break;
        case 'player_escaped':
        case 'game_finished':
            playActionSound('escape');
            break;
        case 'noise_pulse':
            playNoise(ctx, 0.18, 0.045, event.animationCue?.intensity === 'high' ? 220 : 360);
            break;
        case 'player_damaged':
        case 'room_collapsed':
            playNoise(ctx, 0.28, 0.07, 170);
            playTone(ctx, 74, 0.2, 'sawtooth', 0.04);
            break;
        case 'room_unstable':
            playNoise(ctx, 0.18, 0.045, 260);
            break;
        case 'game_waiting':
        case 'action_submitted':
        case 'escape_failed':
            break;
    }
}

export function startAmbientSound(): boolean {
    const ctx = ensureAudioContext();
    if (!ctx) {
        return false;
    }

    if (ambientSound) {
        return true;
    }

    const master = ctx.createGain();
    master.gain.value = 0.05;
    master.connect(ctx.destination);

    const drones = [
        createDrone(ctx, master, 55, 'sine', 0.034),
        createDrone(ctx, master, 82.41, 'triangle', 0.022),
        createDrone(ctx, master, 110, 'sine', 0.018),
    ];

    const chimeTimer = window.setInterval(() => {
        playNoise(ctx, 1.2, 0.012, 640);
        const root = 220 + Math.random() * 30;
        playTone(ctx, root * 2, 1.4, 'sine', 0.011, 0.15);
        playTone(ctx, root * 3, 1.8, 'triangle', 0.008, 0.7);
    }, 7_200);

    ambientSound = {
        master,
        drones,
        chimeTimer,
    };
    return true;
}

export function stopAmbientSound(): void {
    if (!ambientSound) {
        return;
    }

    window.clearInterval(ambientSound.chimeTimer);
    for (const drone of ambientSound.drones) {
        drone.oscillator.stop();
        drone.lfo.stop();
        drone.oscillator.disconnect();
        drone.gain.disconnect();
        drone.lfo.disconnect();
        drone.lfoGain.disconnect();
    }
    ambientSound.master.disconnect();
    ambientSound = undefined;
}

export function isAmbientSoundPlaying(): boolean {
    return !!ambientSound;
}

function ensureAudioContext(): AudioContext | undefined {
    const AudioContextCtor = globalThis.AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
    if (!AudioContextCtor) {
        return undefined;
    }

    audioContext ??= new AudioContextCtor();
    if (audioContext.state === 'suspended') {
        void audioContext.resume();
    }

    return audioContext;
}

function createDrone(
    ctx: AudioContext,
    master: GainNode,
    frequency: number,
    type: OscillatorType,
    volume: number,
): AmbientDrone {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();

    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.value = volume;
    lfo.frequency.value = 0.035 + Math.random() * 0.03;
    lfoGain.gain.value = frequency * 0.012;

    lfo.connect(lfoGain);
    lfoGain.connect(oscillator.frequency);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start();
    lfo.start();
    return {
        oscillator,
        gain,
        lfo,
        lfoGain,
    };
}

function playTone(
    ctx: AudioContext,
    frequency: number,
    durationSeconds: number,
    type: OscillatorType,
    volume: number,
    delaySeconds = 0,
): void {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const start = ctx.currentTime + delaySeconds;
    const end = start + durationSeconds;

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.02);
}

function playNoise(
    ctx: AudioContext,
    durationSeconds: number,
    volume: number,
    filterFrequency: number,
): void {
    const sampleCount = Math.max(1, Math.floor(ctx.sampleRate * durationSeconds));
    const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < sampleCount; index += 1) {
        channel[index] = (Math.random() * 2 - 1) * (1 - index / sampleCount);
    }

    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    source.buffer = buffer;
    filter.type = 'lowpass';
    filter.frequency.value = filterFrequency;
    gain.gain.value = volume;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start();
    source.stop(ctx.currentTime + durationSeconds);
}

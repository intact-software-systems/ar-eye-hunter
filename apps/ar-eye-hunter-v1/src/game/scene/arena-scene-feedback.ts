import type { ProceduralArenaAudio } from '../arenaAudio.ts';
import { createTouchControlDiagnostics } from '../mobileInput.ts';
import type { ArenaLinkState, ArenaPresenceNotice } from '../squadLink.ts';
import type { ArenaSceneRuntime } from './arena-scene-runtime.ts';
import { isHostileEye } from './arena-target-view.ts';

interface SyncAdaptiveAudioInput {
    readonly runtime: ArenaSceneRuntime;
    readonly linkState: ArenaLinkState;
    readonly presenceNotices: readonly ArenaPresenceNotice[];
    readonly localPlayerId: string;
    readonly now: number;
}

export function syncAdaptiveAudio(
    { runtime, linkState, presenceNotices, localPlayerId, now }: SyncAdaptiveAudioInput
): void {
    const match = runtime.arenaState.match;
    runtime.linkTone = linkState.tone;
    const matchRemainingRatio = match?.status === 'active'
        ? Math.max(0, Math.min(1, (match.endsAtEpochMs - now) / match.durationMs))
        : 1;
    const healthRatio = runtime.localPlayer.vitals.maxHealth > 0
        ? runtime.localPlayer.vitals.health / runtime.localPlayer.vitals.maxHealth
        : 1;
    const hostileCount = runtime.arenaState.targets.filter(isHostileEye).length;
    runtime.audioLayerState = runtime.audio.updateMusic({
        matchStatus: match?.status ?? 'infinite',
        matchRemainingRatio,
        wavePhase: runtime.arenaState.wave.phase,
        waveNumber: runtime.arenaState.wave.number,
        hostileCount,
        incomingAttack: runtime.arenaState.attacks.some((attack) => attack.targetSessionId === localPlayerId),
        healthRatio,
        linkTone: linkState.tone,
        reducedIntensity: runtime.audioSettings.reducedIntensity
    });

    playArenaMilestones(runtime);

    if (healthRatio <= 0.3 && !runtime.lowHealthWarned) {
        runtime.audio.play({ kind: 'low-health-warning' });
        runtime.lowHealthWarned = true;
    }
    else if (healthRatio > 0.45) {
        runtime.lowHealthWarned = false;
    }

    for (const notice of presenceNotices) {
        if (runtime.playedNoticeIds.has(notice.id)) {
            continue;
        }
        runtime.playedNoticeIds.add(notice.id);
        runtime.audio.play({ kind: toPresenceAudioKind(notice.kind) });
    }
    if (runtime.playedNoticeIds.size > 64) {
        runtime.playedNoticeIds = new Set([...runtime.playedNoticeIds].slice(-32));
    }
}

function toPresenceAudioKind(
    kind: ArenaPresenceNotice['kind']
): Exclude<Parameters<ProceduralArenaAudio['play']>[0]['kind'], 'shot' | 'eye-drone'> {
    if (kind === 'joined' || kind === 'link-live') {
        return 'link-joined';
    }
    if (kind === 'left' || kind === 'link-degraded') {
        return 'link-left';
    }
    return 'sync';
}

export function unlockArenaAudio(runtime: ArenaSceneRuntime): void {
    if (!runtime.audioSettings.autoStartOnGesture || runtime.audioSettings.muted) {
        return;
    }
    void runtime.audio.unlock().catch(() => undefined);
}

export function forceUnlockArenaAudio(runtime: ArenaSceneRuntime): void {
    void runtime.audio.unlock().catch(() => undefined);
}

export function writeArenaDiagnostics(canvas: HTMLCanvasElement, runtime: ArenaSceneRuntime): void {
    canvas.dataset.arenaRuntimeReady = 'true';
    canvas.dataset.arenaVisualTheme = 'neon-matrix';
    canvas.dataset.arenaMeshCount = String(runtime.scene.meshes.length);
    canvas.dataset.arenaEffectCount = String(runtime.createdEffectCount);
    canvas.dataset.arenaActiveEffectCount = String(runtime.transientEffects.length);
    canvas.dataset.arenaMatchId = runtime.arenaState.match?.matchId ?? '';
    canvas.dataset.arenaSnapshotRevision = String(runtime.arenaState.revision);
    canvas.dataset.arenaPlayerIds = runtime.arenaState.players.map((player) => player.sessionId).join(',');
    canvas.dataset.arenaAvatarCount = String(runtime.avatars.size);
    canvas.dataset.arenaShotSequence = String(runtime.shotSeqRef.current);
    canvas.dataset.arenaTargetCount = String(runtime.targets.size);
    canvas.dataset.arenaPointerDownCount = String(runtime.pointerDownCount);
    canvas.dataset.arenaSize = String(runtime.arenaState.layout.halfSize * 2);
    canvas.dataset.arenaLayoutId = runtime.arenaState.layout.id;
    canvas.dataset.arenaPickupCount = String(
        runtime.arenaState.pickups.filter((pickup) => !pickup.pickedBySessionId).length
    );
    canvas.dataset.arenaWeaponKind = runtime.localPlayer.loadout.weaponKind;
    canvas.dataset.arenaLocalHealth = String(Math.ceil(runtime.localPlayer.vitals.health));
    canvas.dataset.arenaAcceptedHitCount = String(runtime.acceptedHitCount);
    canvas.dataset.arenaRespawnCount = String(runtime.respawnCount);
    canvas.dataset.arenaActiveChaosId = runtime.arenaState.activeEvent?.id ?? '';
    canvas.dataset.arenaWave = String(runtime.arenaState.wave.number);
    canvas.dataset.arenaWavePhase = runtime.arenaState.wave.phase;
    canvas.dataset.arenaAttackCount = String(runtime.arenaState.attacks.length);
    canvas.dataset.arenaHostileEyeCount = String(
        runtime.arenaState.targets.filter(isHostileEye).length
    );
    const touchDiagnostics = createTouchControlDiagnostics(runtime.touchState, runtime.touchStick);
    canvas.dataset.arenaInputMode = touchDiagnostics.lastInputMode;
    canvas.dataset.arenaMobileControls = runtime.mobileControlsEnabled ? 'true' : 'false';
    canvas.dataset.arenaTouchMoveActive = touchDiagnostics.movePointerId === undefined ? 'false' : 'true';
    canvas.dataset.arenaTouchLookActive = touchDiagnostics.lookActive ? 'true' : 'false';
    canvas.dataset.arenaGyroEnabled = runtime.mobileSettings.gyroEnabled ? 'true' : 'false';
    const audioDiagnostics = runtime.audio.diagnostics();
    canvas.dataset.arenaAudioUnlocked = audioDiagnostics.unlocked ? 'true' : 'false';
    canvas.dataset.arenaAudioState = audioDiagnostics.contextState;
    canvas.dataset.arenaAudioMuted = audioDiagnostics.muted ? 'true' : 'false';
    canvas.dataset.arenaAudioVoices = String(audioDiagnostics.activeVoices);
    canvas.dataset.arenaAudioLayer = audioDiagnostics.musicLayer;
    canvas.dataset.arenaAudioIntensity = String(audioDiagnostics.musicIntensity);
    canvas.dataset.arenaLinkState = runtime.linkTone;
}

export function triggerHaptic(runtime: ArenaSceneRuntime, durationMs: number): void {
    if (!runtime.mobileSettings.hapticsEnabled || typeof navigator === 'undefined') {
        return;
    }
    navigator.vibrate?.(Math.max(4, Math.min(60, durationMs)));
}
function playArenaMilestones(runtime: ArenaSceneRuntime): void {
    const match = runtime.arenaState.match;
    const matchKey = match ? `${match.matchId}:${match.status}` : 'infinite';
    if (runtime.lastAudioMatchStatus !== matchKey) {
        if (match?.status === 'active') {
            runtime.audio.play({ kind: 'match-start' });
        }
        else if (match?.status === 'complete') {
            runtime.audio.play({ kind: 'match-end' });
        }
        runtime.lastAudioMatchStatus = matchKey;
    }

    const waveKey = `${runtime.arenaState.wave.number}:${runtime.arenaState.wave.phase}`;
    if (runtime.lastAudioWaveKey !== waveKey) {
        if (runtime.arenaState.wave.phase === 'active') {
            runtime.audio.play({ kind: 'wave-start' });
        }
        else if (runtime.arenaState.wave.phase === 'reward') {
            runtime.audio.play({ kind: 'wave-complete' });
        }
        runtime.lastAudioWaveKey = waveKey;
    }
}

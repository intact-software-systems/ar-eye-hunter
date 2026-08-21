import type { RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import { AVATAR_ARRIVAL_SETTLE_MS, AVATAR_MOVING_STEP_CYCLE_MS } from './motionTuning.ts';

export { AVATAR_ARRIVAL_SETTLE_MS };

export type RelicAvatarStatus =
    | 'lobby'
    | 'idle'
    | 'moving'
    | 'arriving'
    | 'locked'
    | 'escaped'
    | 'defeated';

export type RelicAvatarPresentation = Readonly<{
    status: RelicAvatarStatus;
    visible: boolean;
    labelVisible: boolean;
    opacity: number;
    baseScale: number;
    emissiveRole: 'idle' | 'action' | 'locked' | 'escaped' | 'defeated';
}>;

export function deriveRelicAvatarPresentation({
    phase,
    player,
    submittedPlayerIds,
    isMoving,
    lastMovedAgoMs
}: Readonly<{
    phase: RelicPublicSnapshot['phase'];
    player: Pick<RelicPublicSnapshot['players'][number], 'playerId' | 'escaped' | 'defeated'>;
    submittedPlayerIds: readonly string[];
    isMoving: boolean;
    lastMovedAgoMs?: number;
}>): RelicAvatarPresentation {
    if (phase === 'lobby') {
        return avatarPresentationForStatus('lobby');
    }
    if (player.defeated) {
        return avatarPresentationForStatus('defeated');
    }
    if (player.escaped) {
        return avatarPresentationForStatus('escaped');
    }
    if (phase === 'planning' && submittedPlayerIds.includes(player.playerId)) {
        return avatarPresentationForStatus('locked');
    }
    if (isMoving) {
        return avatarPresentationForStatus('moving');
    }
    if (typeof lastMovedAgoMs === 'number' && lastMovedAgoMs >= 0 && lastMovedAgoMs < AVATAR_ARRIVAL_SETTLE_MS) {
        return avatarPresentationForStatus('arriving');
    }
    return avatarPresentationForStatus('idle');
}

export function avatarPresentationForStatus(status: RelicAvatarStatus): RelicAvatarPresentation {
    switch (status) {
        case 'lobby':
            return {
                status,
                visible: true,
                labelVisible: true,
                opacity: 1,
                baseScale: 1.08,
                emissiveRole: 'idle'
            };
        case 'moving':
            return {
                status,
                visible: true,
                labelVisible: true,
                opacity: 1,
                baseScale: 1.12,
                emissiveRole: 'action'
            };
        case 'arriving':
            return {
                status,
                visible: true,
                labelVisible: true,
                opacity: 1,
                baseScale: 1.10,
                emissiveRole: 'idle'
            };
        case 'locked':
            return {
                status,
                visible: true,
                labelVisible: true,
                opacity: 1,
                baseScale: 1.10,
                emissiveRole: 'locked'
            };
        case 'escaped':
            return {
                status,
                visible: true,
                labelVisible: true,
                opacity: 0.56,
                baseScale: 0.92,
                emissiveRole: 'escaped'
            };
        case 'defeated':
            return {
                status,
                visible: true,
                labelVisible: true,
                opacity: 0.48,
                baseScale: 0.82,
                emissiveRole: 'defeated'
            };
        case 'idle':
        default:
            return {
                status: 'idle',
                visible: true,
                labelVisible: true,
                opacity: 1,
                baseScale: 1.08,
                emissiveRole: 'idle'
            };
    }
}

export function avatarPoseOffsets({
    presentation,
    nowMs,
    lastMovedAgoMs
}: Readonly<{
    presentation: RelicAvatarPresentation;
    nowMs: number;
    lastMovedAgoMs?: number;
}>): Readonly<{
    yOffset: number;
    pitch: number;
    roll: number;
    scaleY: number;
}> {
    switch (presentation.status) {
        case 'moving': {
            const step = Math.sin(nowMs / AVATAR_MOVING_STEP_CYCLE_MS);
            return {
                yOffset: 0.055 + Math.abs(step) * 0.06,
                pitch: -0.16,
                roll: step * 0.105,
                scaleY: 1.035
            };
        }
        case 'arriving': {
            const age = Math.max(0, lastMovedAgoMs ?? AVATAR_ARRIVAL_SETTLE_MS);
            const settle = Math.max(0, 1 - age / AVATAR_ARRIVAL_SETTLE_MS);
            return {
                yOffset: Math.sin(age / 54) * 0.035 * settle,
                pitch: 0.02 * settle,
                roll: Math.sin(age / 72) * 0.045 * settle,
                scaleY: 1 + 0.035 * settle
            };
        }
        case 'locked':
            return {
                yOffset: 0.025 + Math.sin(nowMs / 1250) * 0.012,
                pitch: 0,
                roll: 0,
                scaleY: 1.01
            };
        case 'escaped':
            return {
                yOffset: 0.16 + Math.sin(nowMs / 1450) * 0.018,
                pitch: 0,
                roll: 0,
                scaleY: 0.96
            };
        case 'defeated':
            return {
                yOffset: -0.24,
                pitch: 0.58,
                roll: -0.36,
                scaleY: 0.70
            };
        case 'lobby':
            return {
                yOffset: Math.sin(nowMs / 1500) * 0.018,
                pitch: 0,
                roll: Math.sin(nowMs / 1800) * 0.018,
                scaleY: 1.01
            };
        case 'idle':
        default:
            return {
                yOffset: Math.sin(nowMs / 1650) * 0.014,
                pitch: 0,
                roll: Math.sin(nowMs / 2100) * 0.015,
                scaleY: 1
            };
    }
}

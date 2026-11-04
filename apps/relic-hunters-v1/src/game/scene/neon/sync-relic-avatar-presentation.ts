import type { RelicCameraMode } from '../relic-scene-model.ts';
import type { AvatarBundle, FirstPersonRig } from './relic-avatars.ts';

export interface RelicAvatarPresentationInput {
    readonly avatars: ReadonlyMap<string, Pick<AvatarBundle, 'parts' | 'label' | 'trail'>>;
    readonly firstPersonRig: FirstPersonRig;
    readonly localPlayerId: string | undefined;
    readonly cameraMode: RelicCameraMode;
}

export function syncRelicAvatarPresentation(input: RelicAvatarPresentationInput): void {
    const firstPerson = input.cameraMode === 'first-person' && input.localPlayerId !== undefined &&
        input.avatars.has(input.localPlayerId);
    for (const [playerId, avatar] of input.avatars) {
        const hidden = firstPerson && playerId === input.localPlayerId;
        for (const part of avatar.parts) {
            if (part !== avatar.trail) {
                part.setEnabled(!hidden);
            }
        }
        avatar.label.setEnabled(!hidden);
        if (hidden) {
            avatar.trail.setEnabled(false);
        }
    }
    input.firstPersonRig.root.setEnabled(firstPerson);
}

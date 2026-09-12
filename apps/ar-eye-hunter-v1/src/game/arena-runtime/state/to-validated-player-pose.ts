import { createDeterministicAvatarProfile, validateAvatarProfile } from '../../avatarProfile.ts';
import type { PlayerPose } from '../../types.ts';

export function toValidatedPlayerPose(pose: PlayerPose): PlayerPose {
    const validation = validateAvatarProfile(pose.avatarProfile, pose.sessionId);
    return {
        ...pose,
        avatarProfile: validation.ok
            ? validation.profile
            : createDeterministicAvatarProfile(pose.sessionId, pose.username)
    };
}

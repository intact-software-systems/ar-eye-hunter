import type { PlayerPose } from '../../arena-contracts.ts';
import { createDeterministicAvatarProfile, validateAvatarProfile } from '../../avatarProfile.ts';

export function toValidatedPlayerPose(pose: PlayerPose): PlayerPose {
    const validation = validateAvatarProfile(pose.avatarProfile, pose.sessionId);
    return {
        ...pose,
        avatarProfile: validation.ok
            ? validation.profile
            : createDeterministicAvatarProfile(pose.sessionId, pose.username)
    };
}

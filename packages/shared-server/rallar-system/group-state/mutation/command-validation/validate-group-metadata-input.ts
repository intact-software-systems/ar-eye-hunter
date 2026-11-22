import { ROOM_DIRECTOR_SUCCESSION_METADATA_KEY } from '@shared/api/group-director-succession.ts';
import { ROOM_LOBBY_METADATA_KEY } from '@shared/api/room-lobbies/room-lobby-policy.ts';
import { ROOM_LOBBY_REGISTRATION_METADATA_KEY } from '@shared/api/room-lobbies/room-lobby-registration.ts';
import { GROUP_DIRECTORY_LISTING_METADATA_KEY } from '@shared/api/group-directory/group-directory-listing.ts';
import { assertRoomClockMutation, ROOM_CLOCKS_METADATA_KEY } from '@shared/api/group-deadlines/room-clock.ts';
import { assertRoomDeadlineChange, ROOM_DEADLINES_METADATA_KEY } from '@shared/api/group-deadlines/room-deadline.ts';

import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { isGroupInputRecord, validateGroupInputFields } from './group-input-validation-issues.ts';

/** Raw metadata never owns deadlines. Only a validated, separate change can publish one. */
export function validateGroupMetadataInput(
    metadata: JsonWireValue | undefined,
    deadlineChange: JsonWireValue | undefined,
    clockCommand?: JsonWireValue
): readonly TypeError[] {
    const issues: TypeError[] = [];
    if (isGroupInputRecord(metadata)) {
        issues.push(...validateGroupInputFields(metadata, [{
            key: GROUP_DIRECTORY_LISTING_METADATA_KEY,
            kind: 'enum',
            allowed: ['listed', 'unlisted']
        }], 'Group metadata'));
        if (Object.hasOwn(metadata, ROOM_DIRECTOR_SUCCESSION_METADATA_KEY)) {
            issues.push(new TypeError('Director succession metadata is server-owned.'));
        }
        if (Object.hasOwn(metadata, ROOM_LOBBY_METADATA_KEY) || Object.hasOwn(metadata, ROOM_LOBBY_REGISTRATION_METADATA_KEY)) {
            issues.push(new TypeError('Room lobby metadata is server-owned; use roomLobby.'));
        }
        if (Object.hasOwn(metadata, ROOM_CLOCKS_METADATA_KEY)) {
            issues.push(new TypeError('Room clock metadata is server-owned.'));
        }
        if (Object.hasOwn(metadata, ROOM_DEADLINES_METADATA_KEY)) {
            issues.push(new TypeError('Room deadline metadata is server-owned; use roomDeadline'));
        }
    }
    if (clockCommand !== undefined) {
        try {
            assertRoomClockMutation(clockCommand);
        }
        catch (error) {
            if (!(error instanceof TypeError)) throw error;
            issues.push(error);
        }
    }
    if (deadlineChange !== undefined) {
        try {
            assertRoomDeadlineChange(deadlineChange);
        }
        catch (error) {
            if (!(error instanceof TypeError)) {
                throw error;
            }
            issues.push(error);
        }
    }
    return issues;
}

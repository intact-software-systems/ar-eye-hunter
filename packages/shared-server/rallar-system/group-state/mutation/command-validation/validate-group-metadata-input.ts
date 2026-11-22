import { ROOM_LOBBY_METADATA_KEY, decodeRoomLobbyPolicy } from '@shared/api/room-lobbies/room-lobby-policy.ts';
import { requireExactKeys, requireRecord } from '@shared/api/exact-object-decoding.ts';
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
        if (Object.hasOwn(metadata, ROOM_LOBBY_METADATA_KEY)) {
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

export function validateGroupLobbyInput(operation: 'createGroup' | 'updateGroup', value: JsonWireValue | undefined): readonly TypeError[] {
    if (value === undefined) return [];
    try {
        if (operation === 'createGroup') {
            if (value !== null) decodeRoomLobbyPolicy(value);
        }
        else {
            const command = requireRecord(value, 'Lobby command');
            if (command.operation === 'configure') {
                requireExactKeys(command, ['operation', 'policy'], 'Lobby configuration');
                if (command.policy !== null) decodeRoomLobbyPolicy(command.policy);
            }
            else {
                requireExactKeys(command, ['operation'], 'Lobby command');
                if (command.operation !== 'release') throw new TypeError('Unknown lobby command');
            }
        }
    }
    catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return [error];
    }
    return [];
}

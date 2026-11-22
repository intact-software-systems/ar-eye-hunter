import { assertRoomLobbyRegistrationBoundary } from '@shared/api/room-lobbies/room-lobby-registration-boundary.ts';
import { decodeRoomLobbyPolicy } from '@shared/api/room-lobbies/room-lobby-policy.ts';
import { requireEpoch, requireExactKeys, requireRecord } from '@shared/api/exact-object-decoding.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';

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
            else if (command.operation === 'set-registration-cutoff') {
                requireExactKeys(command, ['operation', 'expectedRevision', 'atEpochMs'], 'Lobby registration cutoff');
                requireEpoch(command.expectedRevision, 'Expected registration revision');
                if (command.atEpochMs !== null) requireEpoch(command.atEpochMs, 'Registration cutoff');
            }
            else if (command.operation === 'set-registration-boundary') {
                requireExactKeys(command, ['operation', 'expectedRevision', 'expectedProgramRevision', 'program', 'phase'], 'Registration boundary');
                assertRoomLobbyRegistrationBoundary(command);
            }
            else if (command.operation === 'wait') {
                requireExactKeys(command, Object.hasOwn(command, 'joinCode') ? ['operation', 'joinCode'] : ['operation'], 'Lobby wait');
                if (Object.hasOwn(command, 'joinCode') && (typeof command.joinCode !== 'string' || !command.joinCode.trim())) throw new TypeError('Invalid lobby join code');
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

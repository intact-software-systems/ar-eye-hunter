import { decodeALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import { AL_CHANNEL_PURPOSES } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { BlackBoxRallarMessageSendInput } from '../black-box-rallar-operation-contracts.ts';
import type {
    BlackBoxRallarCommandRecord,
    BlackBoxRallarInputIssue
} from '../decode-black-box-rallar-command-input.ts';

export type BlackBoxRallarMessageChannel = Pick<BlackBoxRallarMessageSendInput, 'purpose' | 'publication'>;

/**
 * The typed channel a `messages.send` opens. A live channel paces by its publication, so a send names the two together
 * or neither (D472); a null purpose reads as absent, the way the recipe schema writes an unset option.
 */
export function decodeBlackBoxRallarMessageChannel(
    record: BlackBoxRallarCommandRecord
): Either<BlackBoxRallarInputIssue, BlackBoxRallarMessageChannel> {
    const purpose = AL_CHANNEL_PURPOSES.find((candidate) => candidate === record.purpose);
    if (record.purpose !== undefined && record.purpose !== null && purpose === undefined) {
        return Either.ofLeft({ message: 'messages.send.purpose must be command, notification or live.' });
    }
    if (record.publication === undefined) {
        return purpose === 'live'
            ? Either.ofLeft({ message: 'messages.send.purpose live requires a publication.' })
            : Either.ofRight({ purpose, publication: undefined });
    }
    if (purpose !== 'live') {
        return Either.ofLeft({ message: 'messages.send.publication is allowed only with purpose live.' });
    }
    return decodeALPublicationPolicy(record.publication).mapBoth(
        (issues) => ({
            message: issues.map((issue) => `messages.send${issue.path.slice(1)}: ${issue.message}`).join(' ')
        }),
        (publication) => ({ purpose, publication })
    );
}

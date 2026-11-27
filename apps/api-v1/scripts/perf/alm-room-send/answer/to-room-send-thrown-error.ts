import { toError } from '@shared/resilience/to-error.ts';

/** What the cell keeps of an error something threw: enough to tell errors apart, and nothing a credential could be in. */
export interface RoomSendThrownError {
    readonly errorName: string;
    readonly errorMessage: string;
}

/** The most characters of an error's message the cell prints or records. */
const ROOM_SEND_THROWN_MESSAGE_MAX_LENGTH = 240;

/** The most characters of an error's name the cell prints or records. */
const THROWN_NAME_MAX_LENGTH = 80;

const ELLIPSIS = '…';

/** The quoted value a URL parser reports of the text it was given, as Bun prints it of an invalid URL. */
const QUOTED_INPUT = /\binput: ?"(?:[^"\\]|\\.)*"/g;

/** A scheme, `://` and everything up to the next space, quote or angle bracket. */
const URL_SHAPED = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** A `user:password@host` run with no scheme before it, as a URL that lost its `://` leaves. */
const CREDENTIAL_SHAPED = /[^\s"'<>]+:[^\s"'<>@]*@[^\s"'<>]+/g;

/**
 * The name and the message of an error with everything URL-shaped removed and each bounded in length: the database
 * URL is a credential, and an error from a database driver or a URL parser may repeat it. The stack and every other
 * property of the error are left out.
 */
export function toRoomSendThrownError(error: Error): RoomSendThrownError {
    return {
        errorName: toBoundedText(toTextWithoutUrls(error.name), THROWN_NAME_MAX_LENGTH),
        errorMessage: toBoundedText(toTextWithoutUrls(error.message), ROOM_SEND_THROWN_MESSAGE_MAX_LENGTH)
    };
}

/** The lines to print of a run that could not be carried out: the error, then each error an aggregate holds. */
export function toRoomSendFailureLines(error: Error): readonly string[] {
    const errors = error instanceof AggregateError ? [error, ...error.errors.map(toError)] : [error];
    return errors.map(toRoomSendThrownError).map(({ errorName, errorMessage }) => `${errorName}: ${errorMessage}`);
}

function toTextWithoutUrls(text: string): string {
    return text
        .replaceAll(QUOTED_INPUT, 'input: <removed>')
        .replaceAll(URL_SHAPED, '<url removed>')
        .replaceAll(CREDENTIAL_SHAPED, '<url removed>');
}

function toBoundedText(text: string, maxLength: number): string {
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - ELLIPSIS.length)}${ELLIPSIS}`;
}

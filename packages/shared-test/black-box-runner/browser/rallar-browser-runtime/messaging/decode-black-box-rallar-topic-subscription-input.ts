import { Either } from '@shared/resilience/Either.ts';

import {
    decodeBlackBoxCommandNumber,
    decodeBlackBoxCommandString,
    isBlackBoxCommandRecord,
    type BlackBoxRallarInputIssue
} from '../decode-black-box-rallar-command-input.ts';
import type { BlackBoxRallarTopicSubscriptions } from './black-box-rallar-topic-subscriptions.ts';

export function decodeBlackBoxRallarTopicSubscribeInput(
    value: unknown
): Either<BlackBoxRallarInputIssue, BlackBoxRallarTopicSubscriptions.SubscribeInput> {
    return decodeBlackBoxRallarTopicUnsubscribeInput(value).flatMap(
        (issue) => Either.ofLeft(issue),
        (token) => {
            const timeoutMs = isBlackBoxCommandRecord(value) ? decodeBlackBoxCommandNumber(value.timeoutMs) : undefined;
            return timeoutMs === undefined
                ? Either.ofLeft({ message: 'messages.subscribe.timeoutMs is required.' })
                : Either.ofRight({ ...token, timeoutMs });
        }
    );
}

export function decodeBlackBoxRallarTopicUnsubscribeInput(
    value: unknown
): Either<BlackBoxRallarInputIssue, BlackBoxRallarTopicSubscriptions.UnsubscribeInput> {
    return decodeBlackBoxRallarTopicSubscriptionsInput(value).flatMap(
        (issue) => Either.ofLeft(issue),
        (read) => {
            const subscriptionId = isBlackBoxCommandRecord(value)
                ? decodeBlackBoxCommandString(value.subscriptionId)
                : undefined;
            return subscriptionId === undefined
                ? Either.ofLeft({ message: 'topic subscription subscriptionId is required.' })
                : Either.ofRight({ ...read, subscriptionId });
        }
    );
}

export function decodeBlackBoxRallarTopicSubscriptionsInput(
    value: unknown
): Either<BlackBoxRallarInputIssue, BlackBoxRallarTopicSubscriptions.ReadInput> {
    if (!isBlackBoxCommandRecord(value)) {
        return Either.ofLeft({ message: 'topic subscription input must be an object.' });
    }
    const connection = decodeBlackBoxCommandString(value.connection);
    return connection === undefined
        ? Either.ofLeft({ message: 'topic subscription connection is required.' })
        : Either.ofRight({ connection });
}

import { describe, expect, it } from 'vitest';

import {
    decodeGroupStateGroupStorageKey,
    groupStateGroupStorageKey
} from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import {
    decodeGroupStateIdempotencyStorageKey,
    groupStateIdempotencyStorageKey
} from '@shared-server/rallar-system/group-state/persistence/idempotency/group-idempotency-storage-key.ts';
import {
    decodeGroupStateMemberStorageKey,
    groupStateMemberStorageKey
} from '@shared-server/rallar-system/group-state/persistence/membership/group-membership-storage-key.ts';
import {
    decodeGroupStatePresenceAdmissionStorageKey,
    decodeGroupStatePresenceSessionStorageKey,
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from '@shared-server/rallar-system/group-state/persistence/presence/group-presence-storage-keys.ts';

interface StorageKeyFamily {
    readonly kind: string;
    readonly partNames: readonly string[];
    readonly propertyNames: readonly string[];
    readonly decode: (storageKey: string) => object;
    readonly encode: (values: readonly string[]) => string;
}

interface RejectionCase {
    readonly storageKey: string;
    readonly message: string;
}

const groupPropertyNames = ['applicationId', 'workspaceId', 'groupId'] as const;

const storageKeyFamilies: readonly StorageKeyFamily[] = [
    {
        kind: 'group',
        partNames: ['app', 'ws', 'group'],
        propertyNames: groupPropertyNames,
        decode: decodeGroupStateGroupStorageKey,
        encode: ([applicationId, workspaceId, groupId]) => groupStateGroupStorageKey({ applicationId, workspaceId, groupId })
    },
    {
        kind: 'member',
        partNames: ['app', 'ws', 'group', 'member'],
        propertyNames: [...groupPropertyNames, 'principalId'],
        decode: decodeGroupStateMemberStorageKey,
        encode: ([applicationId, workspaceId, groupId, principalId]) => groupStateMemberStorageKey({ applicationId, workspaceId, groupId, principalId })
    },
    {
        kind: 'session',
        partNames: ['app', 'ws', 'group', 'session'],
        propertyNames: [...groupPropertyNames, 'sessionId'],
        decode: decodeGroupStatePresenceSessionStorageKey,
        encode: ([applicationId, workspaceId, groupId, sessionId]) => groupStatePresenceSessionStorageKey({ applicationId, workspaceId, groupId, sessionId })
    },
    {
        kind: 'principal',
        partNames: ['app', 'ws', 'group', 'principal'],
        propertyNames: [...groupPropertyNames, 'principalId'],
        decode: decodeGroupStatePresenceAdmissionStorageKey,
        encode: ([applicationId, workspaceId, groupId, principalId]) =>
            groupStatePresenceAdmissionStorageKey({ applicationId, workspaceId, groupId, principalId })
    },
    {
        kind: 'request',
        partNames: ['app', 'ws', 'group', 'request'],
        propertyNames: [...groupPropertyNames, 'requestId'],
        decode: decodeGroupStateIdempotencyStorageKey,
        encode: ([applicationId, workspaceId, groupId, requestId]) => groupStateIdempotencyStorageKey({ applicationId, workspaceId, groupId }, requestId)
    }
];

/** Each printable ASCII character on its own, so whether each one is kept or escaped is pinned. */
const PRINTABLE_ASCII_CHARACTERS = Array.from({ length: 95 }, (_, index) => String.fromCharCode(0x20 + index));

const acceptedValues = [
    'a',
    'AZaz09',
    '_',
    '-_.!~*\'()',
    'a:b',
    'a%b',
    'a%3Ab',
    '%5F',
    'a/b',
    'a b',
    'a=b',
    'a+b',
    'æøå',
    '\u{1F600}',
    PRINTABLE_ASCII_CHARACTERS.join(''),
    ...PRINTABLE_ASCII_CHARACTERS
];

const missingNameParts = (name: string): readonly string[] => [
    '',
    name,
    `${name}value`,
    `=${name}`,
    `${name.toUpperCase()}=value`,
    ` ${name}=value`,
    `other=value`
];

const invalidEncodingParts = (name: string): readonly string[] => [
    `${name}=`,
    `${name}=%`,
    `${name}=%2`,
    `${name}=%zz`,
    `${name}=a%`,
    `${name}=%E0%A4`,
    `${name}=%ED%A0%80`,
    `${name}=%C0%AF`,
    `${name}=%FF`
];

const noncanonicalParts = (name: string): readonly string[] => [
    `${name}=%61`,
    `${name}=a%2fb`,
    `${name}=a%2Fb%2f`,
    `${name}=a/b`,
    `${name}=a b`,
    `${name}=a=b`,
    `${name}=a+b`,
    `${name}=%5F`,
    `${name}=%7E`,
    `${name}=%21`,
    `${name}=%27`,
    `${name}=%2A`,
    `${name}=æ`,
    `${name}=%c3%a6`
];

describe('group-state storage key decoding', () => {
    it('decodes every accepted key to the same parts it was encoded from', () => {
        for (const family of storageKeyFamilies) {
            for (let position = 0; position < family.partNames.length; position += 1) {
                for (const value of acceptedValues) {
                    const values = toBaseValues(family).map((base, index) => index === position ? value : base);
                    const storageKey = family.encode(values);

                    expect(storageKey).toBe(
                        family.partNames.map((name, index) => `${name}=${encodeURIComponent(values[index])}`).join(':')
                    );
                    expect(family.decode(storageKey)).toStrictEqual(
                        Object.fromEntries(family.propertyNames.map((property, index) => [property, values[index]]))
                    );
                }
            }
        }
    });

    it('rejects every malformed key with the reason its first failing part gives', () => {
        for (const family of storageKeyFamilies) {
            for (const rejection of toSingleFaultRejections(family)) {
                expect(() => family.decode(rejection.storageKey), rejection.storageKey).toThrow(
                    new TypeError(rejection.message)
                );
            }
        }
    });

    it('reports a group-part decode failure before any canonical-form failure', () => {
        const cases = [
            ['app=%61:ws:group=g:member=m', 'Group-state storage key is missing ws'],
            ['app=%61:ws=w:group=%:member=m', 'Group-state storage key has invalid group encoding'],
            ['app=a:ws=%61:group=g:member', 'Group-state group storage key is not canonical'],
            ['app=a:ws=w:group=%67:member=%', 'Group-state group storage key is not canonical'],
            ['app=a:ws=w:group=%:member=%6D', 'Group-state storage key has invalid group encoding'],
            ['app=%:ws:group=g:member=m', 'Group-state storage key has invalid app encoding'],
            ['app=a:ws=w:group=g:member=%', 'Group-state storage key has invalid member encoding'],
            ['app=a:ws=w:group=g:session=s', 'Group-state storage key is missing member']
        ] as const;

        for (const [storageKey, message] of cases) {
            expect(() => decodeGroupStateMemberStorageKey(storageKey), storageKey).toThrow(new TypeError(message));
        }
    });
});

function toBaseValues(family: StorageKeyFamily): readonly string[] {
    return family.partNames.map((name) => `${name}-value`);
}

function toBaseParts(family: StorageKeyFamily): readonly string[] {
    return toBaseValues(family).map((value, index) => `${family.partNames[index]}=${value}`);
}

function toSingleFaultRejections(family: StorageKeyFamily): readonly RejectionCase[] {
    const baseParts = toBaseParts(family);
    const baseKey = baseParts.join(':');
    const arityMessage = `Group-state ${family.kind} storage key has invalid arity`;
    const arityKeys = [
        '',
        ':',
        baseParts.slice(0, -1).join(':'),
        `${baseKey}:`,
        `:${baseKey}`,
        `${baseKey}:extra=value`,
        `${baseKey}::`,
        baseKey.replace(':', '::')
    ];
    return [
        ...arityKeys.map((storageKey) => ({ storageKey, message: arityMessage })),
        ...family.partNames.flatMap((name, position) => toPartRejections(family, baseParts, name, position))
    ];
}

function toPartRejections(
    family: StorageKeyFamily,
    baseParts: readonly string[],
    name: string,
    position: number
): readonly RejectionCase[] {
    const withPart = (part: string): string => baseParts.map((base, index) => index === position ? part : base).join(':');
    const noncanonicalKind = position < 3 ? 'group' : family.kind;
    return [
        ...missingNameParts(name).map((part) => ({
            storageKey: withPart(part),
            message: `Group-state storage key is missing ${name}`
        })),
        ...invalidEncodingParts(name).map((part) => ({
            storageKey: withPart(part),
            message: `Group-state storage key has invalid ${name} encoding`
        })),
        ...noncanonicalParts(name).map((part) => ({
            storageKey: withPart(part),
            message: `Group-state ${noncanonicalKind} storage key is not canonical`
        }))
    ];
}

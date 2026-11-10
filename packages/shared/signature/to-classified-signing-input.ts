import { serializeCanonicalJson, type CanonicalJsonInput } from '../encoding/canonical-json.ts';

/**
 * Relay-mutable fields are `excluded`: a forwarder rewrites them, so the proof cannot cover them. A field added after
 * the v1 slots is `signed-when-present`: it signs after every v1 slot as a `[path, value]` pair, only when present, so
 * a message without it signs the v1 bytes and builds on either side of the addition verify each other's such messages.
 * Every later signed field is appended this way, trailing and only when present, for the same reason.
 */
export type SignedFieldClass = 'signed' | 'signed-when-present' | 'excluded';

export interface ClassifiedSigningSection {
    readonly name: string;
    readonly fields: Readonly<Record<string, CanonicalJsonInput | undefined>> | undefined;
    readonly classes: Readonly<Record<string, SignedFieldClass>>;
}

/**
 * The domain tag leads, so a signature over these bytes never verifies as another protocol's; an absent signed field
 * signs as `null`, so dropping one changes the bytes as surely as rewriting it. A present `signed-when-present` field
 * follows every slot as its `[path, value]` pair, so dropping or adding one changes the bytes too.
 */
export function toClassifiedSigningInput(domainTag: string, sections: readonly ClassifiedSigningSection[]): string {
    return serializeCanonicalJson([
        domainTag,
        ...sections.flatMap(toSignedSlots),
        ...sections.flatMap(toTrailingPairs)
    ]);
}

function toSignedSlots(section: ClassifiedSigningSection): CanonicalJsonInput[] {
    const slots: CanonicalJsonInput[] = [];
    for (const key in section.classes) {
        if (section.classes[key] === 'signed') {
            slots.push(section.fields?.[key] ?? null);
        }
    }
    return slots;
}

function toTrailingPairs(section: ClassifiedSigningSection): CanonicalJsonInput[] {
    const pairs: CanonicalJsonInput[] = [];
    for (const key in section.classes) {
        const value = section.fields?.[key];
        if (section.classes[key] === 'signed-when-present' && value !== undefined) {
            pairs.push([`${section.name}.${key}`, value]);
        }
    }
    return pairs;
}

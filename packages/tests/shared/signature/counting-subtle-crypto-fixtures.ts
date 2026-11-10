export interface CountingSubtleCrypto {
    readonly subtle: SubtleCrypto;
    readonly counts: Record<'digest' | 'verify' | 'importKey', number>;
    /** Holds the next `verify` call until the returned release runs, so a test orders two verdicts. */
    holdNextVerify(): () => void;
}

type SubtleCryptoMember = SubtleCrypto[keyof SubtleCrypto];

/** The test runtime's WebCrypto, counting each call of the operations a verdict spends. */
export function createCountingSubtleCrypto(): CountingSubtleCrypto {
    const real = globalThis.crypto.subtle;
    const counts = { digest: 0, verify: 0, importKey: 0 };
    let held: Promise<void> | undefined;
    const subtle = new Proxy(real, {
        get(target, property) {
            const member = Reflect.get(target, property, target) as SubtleCryptoMember;
            if (typeof member !== 'function') {
                return member;
            }
            return async (...args: never[]) => {
                if (property === 'digest' || property === 'verify' || property === 'importKey') {
                    counts[property]++;
                }
                if (property === 'verify') {
                    const gate = held;
                    held = undefined;
                    await gate;
                }
                return await Reflect.apply(member, target, args);
            };
        }
    });
    return {
        subtle,
        counts,
        holdNextVerify: () => {
            const gate = Promise.withResolvers<void>();
            held = gate.promise;
            return gate.resolve;
        }
    };
}

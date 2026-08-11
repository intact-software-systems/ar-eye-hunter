// Either.ts
// Converted from org.intact.resilience.Either (Java) to TypeScript.
// - No namespaces
// - Java records -> TypeScript classes with readonly ctor properties
// - Java Optional -> TS uses undefined (left?: L, right?: R)
// - Map.Entry -> readonly [K, V] tuples

export class Either<L, R> {
    public readonly left?: L;
    public readonly right?: R;

    // Matches the Java public fields (Optional<L> left, Optional<R> right)
    // In TS we represent "empty" as undefined.
    constructor(
        left?: L,
        right?: R,
    ) {
        this.left = left;
        this.right = right;
        // Enforce the Java invariant:
        // - both cannot be undefined
        // - both cannot be defined
        const hasLeft = left !== undefined;
        const hasRight = right !== undefined;

        if (hasLeft === hasRight) {
            throw new Error('Either must contain exactly one of left or right');
        }
    }

    /**
     * Equivalent to:
     * Optional.ofNullable(rightSupplier.get())
     *   .map(Either::ofRight)
     *   .orElseGet(() -> Either.ofLeft(leftSupplier.get()));
     */
    static either<L, R>(leftSupplier: () => L, rightSupplier: () => R | null | undefined): Either<L, R> {
        const r = rightSupplier();
        return r !== null && r !== undefined ? Either.ofRight<L, R>(r) : Either.ofLeft<L, R>(leftSupplier());
    }

    static ofLeft<L, R>(left: L): Either<L, R> {
        return new Either<L, R>(left, undefined);
    }

    static ofRight<L, R>(right: R): Either<L, R> {
        return new Either<L, R>(undefined, right);
    }

    fold<T>(mapLeft: (l: L) => T, mapRight: (r: R) => T): T {
        if (this.right !== undefined) {
            return mapRight(this.right);
        }
        if (this.left !== undefined) {
            return mapLeft(this.left);
        }
        // Should be unreachable due to invariant in ctor
        throw new Error('Invalid Either: neither left nor right is present');
    }

    foldRight<T>(mapRight: (r: R) => T): T | undefined {
        return this.right !== undefined ? mapRight(this.right) : undefined;
    }

    foldLeft<T>(mapLeft: (l: L) => T): T | undefined {
        return this.left !== undefined ? mapLeft(this.left) : undefined;
    }

    mapBoth<T, U>(mapLeft: (l: L) => T, mapRight: (r: R) => U): Either<T, U> {
        if (this.right !== undefined) {
            return Either.ofRight<T, U>(mapRight(this.right));
        }
        if (this.left !== undefined) {
            return Either.ofLeft<T, U>(mapLeft(this.left));
        }
        throw new Error('Invalid Either: neither left nor right is present');
    }

    mapRight<R2>(mapRight: (r: R) => R2): Either<L, R2> {
        return this.mapBoth((l) => l, mapRight);
    }

    mapLeft<L2>(mapLeft: (l: L) => L2): Either<L2, R> {
        return this.mapBoth(mapLeft, (r) => r);
    }

    flatMap<T, U>(mapLeft: (l: L) => Either<T, U>, mapRight: (r: R) => Either<T, U>): Either<T, U> {
        if (this.right !== undefined) {
            return mapRight(this.right);
        }
        if (this.left !== undefined) {
            return mapLeft(this.left);
        }
        throw new Error('Invalid Either: neither left nor right is present');
    }
}

// ------------------------------------------
// Java record: EitherCollectors (static utils)
// ------------------------------------------

export class FoldComputedDto<K, L, R> {
    public readonly leftByKey: Map<K, L>;
    public readonly rightByKey: Map<K, R>;

    constructor(
        leftByKey: Map<K, L>,
        rightByKey: Map<K, R>,
    ) {
        this.leftByKey = leftByKey;
        this.rightByKey = rightByKey;
    }
}

export class FoldListComputedDto<K, L, R> {
    public readonly leftsByKey: Map<K, L[]>;
    public readonly rightsByKey: Map<K, R[]>;

    constructor(
        leftsByKey: Map<K, L[]>,
        rightsByKey: Map<K, R[]>,
    ) {
        this.leftsByKey = leftsByKey;
        this.rightsByKey = rightsByKey;
    }
}

export class EitherCollectors {
    static toMapFoldLefts<K, L, R>(eithers: Map<K, Either<L, R>>): Map<K, L> {
        const out = new Map<K, L>();
        for (const [k, either] of eithers.entries()) {
            const left = either.foldLeft((e) => e);
            if (left !== undefined) out.set(k, left);
        }
        return out;
    }

    static toMapFoldRights<K, L, R>(eithers: Map<K, Either<L, R>>): Map<K, R> {
        const out = new Map<K, R>();
        for (const [k, either] of eithers.entries()) {
            const right = either.foldRight((e) => e);
            if (right !== undefined) out.set(k, right);
        }
        return out;
    }

    static toMapFoldBoth<K, L, R>(eitherByKey: Map<K, Either<L, R>>): FoldComputedDto<K, L, R> {
        const leftByKey = new Map<K, L>();
        const rightByKey = new Map<K, R>();

        for (const [k, either] of eitherByKey.entries()) {
            if (either.left !== undefined) leftByKey.set(k, either.left);
            if (either.right !== undefined) rightByKey.set(k, either.right);
        }

        return new FoldComputedDto(leftByKey, rightByKey);
    }

    static toMapFoldListOfLefts<K, L, R>(eithers: Map<K, Array<Either<L, R>>>): Map<K, L[]> {
        const out = new Map<K, L[]>();

        for (const [k, list] of eithers.entries()) {
            const lefts: L[] = [];
            for (const e of list) {
                const l = e.foldLeft((x) => x);
                if (l !== undefined) lefts.push(l);
            }
            if (lefts.length > 0) out.set(k, lefts);
        }

        return out;
    }

    static toMapFoldListOfRights<K, L, R>(eithers: Map<K, Array<Either<L, R>>>): Map<K, R[]> {
        const out = new Map<K, R[]>();

        for (const [k, list] of eithers.entries()) {
            const rights: R[] = [];
            for (const e of list) {
                const r = e.foldRight((x) => x);
                if (r !== undefined) rights.push(r);
            }
            if (rights.length > 0) out.set(k, rights);
        }

        return out;
    }

    static toMapFoldListOfBoth<K, L, R>(eithersByKey: Map<K, Array<Either<L, R>>>): FoldListComputedDto<K, L, R> {
        const leftsByKey = new Map<K, L[]>();
        const rightsByKey = new Map<K, R[]>();

        for (const [k, eithers] of eithersByKey.entries()) {
            const lefts: L[] = [];
            const rights: R[] = [];

            for (const e of eithers) {
                e.fold(
                    (l) => {
                        lefts.push(l);
                        return 0;
                    },
                    (r) => {
                        rights.push(r);
                        return 0;
                    },
                );
            }

            if (lefts.length > 0) leftsByKey.set(k, lefts);
            if (rights.length > 0) rightsByKey.set(k, rights);
        }

        return new FoldListComputedDto(leftsByKey, rightsByKey);
    }

    static toListFoldLefts<L, R>(eithers: Iterable<Either<L, R>>): L[] {
        const out: L[] = [];
        for (const either of eithers) {
            const l = either.foldLeft((x) => x);
            if (l !== undefined) out.push(l);
        }
        return out;
    }

    static toListFoldRights<L, R>(eithers: Iterable<Either<L, R>>): R[] {
        const out: R[] = [];
        for (const either of eithers) {
            const r = either.foldRight((x) => x);
            if (r !== undefined) out.push(r);
        }
        return out;
    }
}

// ------------------------------------------
// Java record: Computers (static utils)
// ------------------------------------------

export class Computers {
    static toMapFoldToOneComputer<K, V, L, R>(
        eithers: Map<K, Either<L, R>>,
        foldLeft: (k: K, l: L) => V,
        foldRight: (k: K, r: R) => V,
    ): Map<K, V> {
        const out = new Map<K, V>();
        for (const [k, either] of eithers.entries()) {
            const v = either.fold(
                (l) => foldLeft(k, l),
                (r) => foldRight(k, r),
            );
            out.set(k, v);
        }
        return out;
    }

    static toMapFoldComputer<K, T, U, L, R>(
        eithers: Map<K, Either<L, R>>,
        foldLeft: (k: K, l: L) => Either<T, U>,
        foldRight: (k: K, r: R) => Either<T, U>,
    ): Map<K, Either<T, U>> {
        const out = new Map<K, Either<T, U>>();
        for (const [k, either] of eithers.entries()) {
            const v = either.fold(
                (l) => foldLeft(k, l),
                (r) => foldRight(k, r),
            );
            out.set(k, v);
        }
        return out;
    }

    static toMapBothComputer<K, T, U, L, R>(
        eithers: Map<K, Either<L, R>>,
        foldLeft: (k: K, l: L) => T,
        foldRight: (k: K, r: R) => U,
    ): Map<K, Either<T, U>> {
        const out = new Map<K, Either<T, U>>();
        for (const [k, either] of eithers.entries()) {
            out.set(
                k,
                either.mapBoth(
                    (l) => foldLeft(k, l),
                    (r) => foldRight(k, r),
                ),
            );
        }
        return out;
    }

    static toMapListBothComputer<K, T, U, L, R>(
        eithers: Map<K, Array<Either<L, R>>>,
        foldLeft: (k: K, l: L) => T,
        foldRight: (k: K, r: R) => U,
    ): Map<K, Array<Either<T, U>>> {
        const out = new Map<K, Array<Either<T, U>>>();

        for (const [k, list] of eithers.entries()) {
            const mapped: Array<Either<T, U>> = list.map((lrEither) =>
                lrEither.mapBoth(
                    (l) => foldLeft(k, l),
                    (r) => foldRight(k, r),
                ),
            );
            out.set(k, mapped);
        }

        return out;
    }
}

// ------------------------------------------
// Java record: Try (static utils)
// ------------------------------------------

function asError(e: unknown): Error {
    return e instanceof Error ? e : new Error(String(e));
}

export class Try {
    static compute<R>(supplier: () => R): Either<Error, R> {
        try {
            return Either.ofRight<Error, R>(supplier());
        } catch (e) {
            return Either.ofLeft<Error, R>(asError(e));
        }
    }

    static computeEntry<K, R>(key: K, supplier: () => R): readonly [K, Either<Error, R>] {
        try {
            return [key, Either.ofRight<Error, R>(supplier())] as const;
        } catch (e) {
            return [key, Either.ofLeft<Error, R>(asError(e))] as const;
        }
    }

    static computeAll<K, R>(lazyMap: Map<K, () => R>): Map<K, Either<Error, R>> {
        const out = new Map<K, Either<Error, R>>();
        for (const [k, supplier] of lazyMap.entries()) {
            out.set(k, Try.compute(supplier));
        }
        return out;
    }
}
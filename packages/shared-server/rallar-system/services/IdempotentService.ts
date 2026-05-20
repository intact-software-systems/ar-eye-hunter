import { Either } from '@shared/resilience/Either.ts';

export type IdempotentInputDto<K, V> = {
    idempotentKeys: K[],
    value: V
}

export type IdempotentReadDto<K, V, R> = {
    input: IdempotentInputDto<K, V>
    read: R
}

export type IdempotentComputedDto<K, V, R, C> = {
    read: IdempotentReadDto<K, V, R>
    computed: C
}

export type IdempotentWrittenDto<K, V, R, C, W> = {
    computed: IdempotentComputedDto<K, V, R, C>,
    written: W
}

export class IdempotentService<K, V> {

    // Read from DB or in-memory, or APIs, but no mutations or persisting (caching is allowd as a side-effect of API calls)
    async read<K, V, R>(
        input: IdempotentInputDto<K, V>,
        reader: (input: IdempotentInputDto<K, V>) => Promise<R>
    ): Promise<IdempotentReadDto<K, V, R>> {
        const read = await reader(input);
        return { input, read };
    }

    // Functional compute the changes to be written to DB (no reading of additional data, no side-effects)
    compute<K, V, R, C>(
        read: IdempotentReadDto<K, V, R>,
        computer: (read: IdempotentReadDto<K, V, R>) => C,
    ): IdempotentComputedDto<K, V, R, C> {
        const computed: C = computer(read);
        return { read: read, computed };
    }

    validate<K, V, R, C, I>(
        computed: IdempotentComputedDto<K, V, R, C>,
        validator: (computed: IdempotentComputedDto<K, V, R, C>) => Either<I, IdempotentComputedDto<K, V, R, C>>,
    ): Either<I, IdempotentComputedDto<K, V, R, C>> {
        return validator(computed);
    }

    // write changes to DB
    async write<K, V, R, C, W>(
        computed: IdempotentComputedDto<K, V, R, C>,
        writer: (computed: IdempotentComputedDto<K, V, R, C>) => Promise<W>
    ): Promise<IdempotentWrittenDto<K, V, R, C, W>> {
        const written: W = await writer(computed);

        return { computed, written };
    }
}
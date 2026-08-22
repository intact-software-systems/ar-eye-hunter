import { Computers, Either, EitherCollectors, Try } from '@shared/resilience/Either.ts';
import { describe, expect, it } from 'vitest';

describe('Either', () => {
    it('enforces the invariant that exactly one side is present', () => {
        expect(() => new Either<string, number>()).toThrow(
            'Either must contain exactly one of left or right'
        );
        expect(() => new Either('left', 1)).toThrow(
            'Either must contain exactly one of left or right'
        );
    });

    it('maps and folds both left and right values', () => {
        const left = Either.ofLeft<string, number>('error');
        const right = Either.ofRight<string, number>(2);

        expect(left.fold((value) => value.toUpperCase(), String)).toBe('ERROR');
        expect(right.fold<string | number>(String, (value) => value * 2)).toBe(4);
        expect(right.mapRight((value) => value + 1).right).toBe(3);
        expect(left.mapLeft((value) => `${value}!`).left).toBe('error!');
        expect(
            right.flatMap(
                (value) => Either.ofLeft<number, string>(value.length),
                (value) => Either.ofRight<number, string>(`v${value}`)
            ).right
        ).toBe('v2');
    });

    it('collects and computes maps of eithers', () => {
        const eithers = new Map<string, Either<string, number>>([
            ['a', Either.ofLeft('bad')],
            ['b', Either.ofRight(2)],
            ['c', Either.ofRight(3)]
        ]);

        expect(
            Array.from(EitherCollectors.toMapFoldLefts(eithers).entries())
        ).toEqual([['a', 'bad']]);
        expect(
            Array.from(EitherCollectors.toMapFoldRights(eithers).entries())
        ).toEqual([
            ['b', 2],
            ['c', 3]
        ]);
        expect(
            Array.from(
                Computers.toMapFoldToOneComputer(
                    eithers,
                    (_key, value) => `left:${value}`,
                    (_key, value) => `right:${value}`
                ).entries()
            )
        ).toEqual([
            ['a', 'left:bad'],
            ['b', 'right:2'],
            ['c', 'right:3']
        ]);
    });

    it('captures synchronous failures with Try helpers', () => {
        const computed = Try.compute(() => 5);
        const failed = Try.compute(() => {
            throw new Error('boom');
        });

        expect(computed.right).toBe(5);
        expect(failed.left?.message).toBe('boom');

        const all = Try.computeAll(
            new Map<string, () => number>([
                ['ok', () => 1],
                [
                    'fail',
                    () => {
                        throw new Error('bad');
                    }
                ]
            ])
        );

        expect(all.get('ok')?.right).toBe(1);
        expect(all.get('fail')?.left?.message).toBe('bad');
    });
});

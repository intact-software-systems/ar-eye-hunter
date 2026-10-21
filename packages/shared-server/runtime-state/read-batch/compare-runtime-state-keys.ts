/**
 * Code-point order, which is the order C collation gives the keys' UTF-8 bytes. UTF-16 units order the same except
 * that a surrogate pair, an astral character, sorts below U+E000-U+FFFF, so the first differing unit is lifted out of
 * that inversion instead of encoding either key.
 */
export function compareRuntimeStateKeys(left: string, right: string): number {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const leftUnit = left.charCodeAt(index);
        const rightUnit = right.charCodeAt(index);
        if (leftUnit !== rightUnit) {
            return toCodePointOrderUnit(leftUnit) - toCodePointOrderUnit(rightUnit);
        }
    }
    return left.length - right.length;
}

function toCodePointOrderUnit(unit: number): number {
    if (unit >= 0xe000) {
        return unit - 0x800;
    }
    return unit >= 0xd800 ? unit + 0x2000 : unit;
}

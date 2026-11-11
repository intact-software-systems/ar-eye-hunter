const UTF8_ENCODER = new TextEncoder();

/** The bytes `TextEncoder` writes for `text`: a lone surrogate counts as the three bytes of the U+FFFD it becomes. */
export function computeUtf8ByteLength(text: string): number {
    return UTF8_ENCODER.encode(text).byteLength;
}

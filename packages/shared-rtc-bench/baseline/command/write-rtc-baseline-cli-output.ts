export function writeRtcBaselineCliOutput(
  writer: { writeSync(bytes: Uint8Array): number },
  value: string,
) {
  const bytes = new TextEncoder().encode(value);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.subarray(offset);
    const written = writer.writeSync(remaining);
    if (written <= 0) {
      throw new Error('Synchronous output writer made no progress.');
    }
    if (written > remaining.byteLength) {
      throw new Error('Synchronous output writer reported an invalid byte count.');
    }
    offset += written;
  }
}

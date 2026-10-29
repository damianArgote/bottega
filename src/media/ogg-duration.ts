/** Opus always runs at 48 kHz in Ogg (RFC 7845). */
const OPUS_RATE = 48_000;
const CAPTURE = Buffer.from('OggS');
const OPUS_HEAD = Buffer.from('OpusHead');

/**
 * Duration in seconds of an Ogg/Opus file (WhatsApp voice notes), without
 * decoding: the granule position of the last page minus the pre-skip of the
 * `OpusHead` header, over 48 000. Null when the bytes are not Ogg/Opus.
 */
export function oggOpusDurationSeconds(file: Buffer): number | null {
  const head = file.indexOf(OPUS_HEAD);
  if (
    file.subarray(0, 4).compare(CAPTURE) !== 0 ||
    head < 0 ||
    head + 12 > file.length
  ) {
    return null;
  }
  const preSkip = file.readUInt16LE(head + 10);
  const last = file.lastIndexOf(CAPTURE);
  // Page header: "OggS", version, flags, then the 64-bit granule position.
  if (last < 0 || last + 14 > file.length) {
    return null;
  }
  const granule = file.readBigInt64LE(last + 6);
  if (granule < 0n) {
    return null;
  }
  return Math.max(0, Number(granule) - preSkip) / OPUS_RATE;
}

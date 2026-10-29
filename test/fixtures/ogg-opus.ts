/** One Ogg page with the given granule position and payload. */
function page(granule: bigint, payload: Buffer): Buffer {
  const header = Buffer.alloc(27);
  header.write('OggS', 0);
  header.writeBigInt64LE(granule, 6);
  header.writeUInt8(1, 26); // one segment
  return Buffer.concat([header, Buffer.from([payload.length]), payload]);
}

function opusHead(preSkip: number): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0);
  head.writeUInt8(1, 8);
  head.writeUInt8(1, 9);
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(48_000, 12);
  return head;
}

/**
 * A minimal Ogg/Opus stream laid out as RFC 7845 describes (OpusHead page,
 * OpusTags page, audio pages) lasting `seconds`. No audio in it: enough for
 * the duration check, not for a real transcription.
 */
export function oggOpusOf(seconds: number, preSkip = 312): Buffer {
  const end = BigInt(Math.round(seconds * 48_000) + preSkip);
  return Buffer.concat([
    page(0n, opusHead(preSkip)),
    page(0n, Buffer.from('OpusTags')),
    page(end / 2n, Buffer.alloc(40)),
    page(end, Buffer.alloc(40)),
  ]);
}

/** Wraps a page builder for the "not Opus" case. */
export function oggPage(granule: bigint, payload: Buffer): Buffer {
  return page(granule, payload);
}

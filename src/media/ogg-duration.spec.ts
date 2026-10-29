import { oggOpusOf, oggPage } from '../../test/fixtures/ogg-opus.js';
import { oggOpusDurationSeconds } from './ogg-duration.js';

describe('oggOpusDurationSeconds', () => {
  it('reads the duration from the last page minus the pre-skip', () => {
    expect(oggOpusDurationSeconds(oggOpusOf(7.5))).toBeCloseTo(7.5, 3);
    expect(oggOpusDurationSeconds(oggOpusOf(185))).toBeCloseTo(185, 3);
  });

  it('is null for something that is not Ogg/Opus', () => {
    expect(oggOpusDurationSeconds(Buffer.from('ID3 mp3 bytes'))).toBeNull();
    expect(oggOpusDurationSeconds(Buffer.alloc(0))).toBeNull();
    // Ogg, but not Opus (e.g. Vorbis).
    expect(
      oggOpusDurationSeconds(oggPage(48_000n, Buffer.from('vorbis'))),
    ).toBeNull();
  });
});

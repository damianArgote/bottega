import { audioTooLongReply, durationText } from './media-replies.js';

describe('durationText', () => {
  it.each([
    [60, '1 minuto'],
    [90, '1 minuto y medio'],
    [120, '2 minutos'],
    [150, '2 minutos y medio'],
    [45, '45 segundos'],
    [100, '100 segundos'],
  ])('%i seconds read as "%s"', (seconds, text) => {
    expect(durationText(seconds)).toBe(text);
  });

  it('puts the limit in the reply', () => {
    expect(audioTooLongReply(120)).toBe(
      'Ese audio es muy largo para mí (hasta 2 minutos). ¿Me mandás uno más corto o me lo escribís?',
    );
  });
});

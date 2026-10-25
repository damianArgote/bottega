import {
  DEMO_BUTTON,
  EXIT_DEMO_BUTTON,
  MAX_BUTTON_TITLE,
  storedButtons,
} from './reply-buttons.js';
import { replyButtons } from './replies.js';

describe('reply buttons', () => {
  it('fixed demo replies go out with their button instead of asking to type', () => {
    expect(replyButtons('NOT_IN_DEMO')).toEqual([DEMO_BUTTON]);
    for (const key of [
      'ENTER_DEMO',
      'ALREADY_IN_DEMO',
      'RESET_DEMO',
    ] as const) {
      expect(replyButtons(key)).toEqual([EXIT_DEMO_BUTTON]);
    }
    expect(replyButtons('EXIT_DEMO')).toEqual([]);
    expect(replyButtons('HUMAN_REQUESTED')).toEqual([]);
  });

  it('titles fit WhatsApp (20 characters)', () => {
    for (const button of [DEMO_BUTTON, EXIT_DEMO_BUTTON]) {
      expect(button.title.length).toBeLessThanOrEqual(MAX_BUTTON_TITLE);
    }
  });

  it('reads stored buttons, and nothing from invalid data', () => {
    expect(storedButtons([{ id: 'a', title: 'A' }])).toEqual([
      { id: 'a', title: 'A' },
    ]);
    expect(storedButtons(null)).toEqual([]);
    expect(storedButtons([{ id: 1 }])).toEqual([]);
  });
});

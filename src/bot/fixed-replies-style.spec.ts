import {
  AI_FALLBACK_REPLY,
  AI_LIMIT_REPLY,
  LEAD_SAVED_ACK,
} from './ai-replies.js';
import { UNSUPPORTED_REPLY } from './echo-replies.js';
import { renderReply, replyButtons, type ReplyKey } from './replies.js';

const EMOJI = /\p{Extended_Pictographic}/u;
const KEYS: ReplyKey[] = [
  'ENTER_DEMO',
  'ALREADY_IN_DEMO',
  'EXIT_DEMO',
  'DEMO_UNAVAILABLE',
  'NOT_IN_DEMO',
  'RESET_COMMERCIAL',
  'RESET_DEMO',
  'HUMAN_REQUESTED',
];

// Emojis only where there are buttons, so those messages stand out.
describe('fixed replies style', () => {
  const vars = { demoBusinessName: 'Zentara', botName: 'Lola' };

  it.each(KEYS)('%s has an emoji exactly when it has buttons', (key) => {
    const text = renderReply(key, vars);
    if (replyButtons(key).length > 0) {
      expect(text).toMatch(EMOJI);
    } else {
      expect(text).not.toMatch(EMOJI);
    }
  });

  it.each([
    ['AI_FALLBACK_REPLY', AI_FALLBACK_REPLY],
    ['AI_LIMIT_REPLY', AI_LIMIT_REPLY],
    ['LEAD_SAVED_ACK', LEAD_SAVED_ACK],
    ['UNSUPPORTED_REPLY', UNSUPPORTED_REPLY],
  ])('%s (no buttons) has no emoji', (_name, text) => {
    expect(text).not.toMatch(EMOJI);
  });
});

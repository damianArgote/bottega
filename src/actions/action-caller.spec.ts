import { hashArguments } from './action-caller.service.js';

describe('hashArguments', () => {
  it('is the same for the same arguments in any order, and differs for other values', () => {
    expect(hashArguments({ dia: 'jueves', hora: '10:00' })).toBe(
      hashArguments({ hora: '10:00', dia: 'jueves' }),
    );
    expect(hashArguments({ dia: 'jueves', hora: '10:00' })).not.toBe(
      hashArguments({ dia: 'viernes', hora: '10:00' }),
    );
    expect(hashArguments({ n: 1 })).not.toBe(hashArguments({ n: '1' }));
  });
});

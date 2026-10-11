import { ZodError } from 'zod';
import type { PrismaService } from '../prisma/prisma.service.js';
import { LeadsService } from './leads.service.js';

function setup() {
  const upsert = vi.fn().mockResolvedValue({ id: 'l1' });
  const service = new LeadsService({
    lead: { upsert },
  } as unknown as PrismaService);
  return { service, upsert };
}

describe('LeadsService.upsertFromConversation', () => {
  it('writes only non-empty, trimmed fields', async () => {
    const { service, upsert } = setup();

    await service.upsertFromConversation('c1', {
      name: ' Ana ',
      businessName: '',
      industry: '   ',
      need: 'turnos',
    });

    expect(upsert).toHaveBeenCalledWith({
      where: { conversationId: 'c1' },
      create: { conversationId: 'c1', name: 'Ana', need: 'turnos' },
      update: { name: 'Ana', need: 'turnos' },
    });
  });

  it('writes nothing when every field is empty', async () => {
    const { service, upsert } = setup();

    expect(
      await service.upsertFromConversation('c1', { name: ' ', need: '' }),
    ).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects unknown fields', async () => {
    const { service } = setup();

    await expect(
      service.upsertFromConversation('c1', {
        phone: '123',
      } as unknown as { name: string }),
    ).rejects.toThrow(ZodError);
  });
});

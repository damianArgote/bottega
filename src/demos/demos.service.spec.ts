import { ZodError } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { ContentService } from '../content/content.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { DemoContextError, DemosService } from './demos.service.js';

function setup(
  context: {
    conversationId: string;
    mode: string;
    demoScenario?: string | null;
  } | null,
) {
  const create = vi.fn((args: { data: unknown }) =>
    Promise.resolve({ id: 'd1', ...(args.data as object) }),
  );
  const tx = {
    conversationContext: { findUnique: vi.fn().mockResolvedValue(context) },
    demoRequest: { create },
  } as unknown as Prisma.TransactionClient;
  const service = new DemosService(
    tx as unknown as PrismaService,
    new ContentService(),
  );
  return { service, create };
}

describe('DemosService.registerDemoRequest', () => {
  it('stores a trimmed, fictitious barbershop request', async () => {
    const { service, create } = setup({ conversationId: 'c1', mode: 'DEMO' });

    await service.registerDemoRequest('c1', 'ctx1', 'barbershop', {
      customerName: '  Juan ',
      service: 'Corte de pelo',
      preferredDate: 'sábado',
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        conversationId: 'c1',
        contextId: 'ctx1',
        scenario: 'barbershop',
        isFictitious: true,
        customerName: 'Juan',
        service: 'Corte de pelo',
        preferredDate: 'sábado',
      },
    });
  });

  it.each([
    ['a commercial context', { conversationId: 'c1', mode: 'COMMERCIAL' }],
    ['another conversation context', { conversationId: 'c2', mode: 'DEMO' }],
    ['a missing context', null],
    [
      'a context running another demo',
      { conversationId: 'c1', mode: 'DEMO', demoScenario: 'insurance' },
    ],
  ])('refuses %s', async (_label, context) => {
    const { service, create } = setup(context);

    await expect(
      service.registerDemoRequest('c1', 'ctx1', 'barbershop', {
        customerName: 'Juan',
      }),
    ).rejects.toThrow(DemoContextError);
    expect(create).not.toHaveBeenCalled();
  });

  it('stores the insurance quote details in its own scenario', async () => {
    const { service, create } = setup({
      conversationId: 'c1',
      mode: 'DEMO',
      demoScenario: 'insurance',
    });

    await service.registerDemoRequest('c1', 'ctx1', 'insurance', {
      customerName: 'Ana',
      service: 'Todo Riesgo',
      details: { vehicle: 'Volkswagen Gol Trend Trendline', monthlyArs: 66700 },
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        conversationId: 'c1',
        contextId: 'ctx1',
        scenario: 'insurance',
        isFictitious: true,
        customerName: 'Ana',
        service: 'Todo Riesgo',
        details: {
          vehicle: 'Volkswagen Gol Trend Trendline',
          monthlyArs: 66700,
        },
      },
    });
  });

  it('rejects unknown fields and empty values', async () => {
    const { service, create } = setup({ conversationId: 'c1', mode: 'DEMO' });

    await expect(
      service.registerDemoRequest('c1', 'ctx1', 'barbershop', {
        dni: '123',
      } as unknown as { customerName: string }),
    ).rejects.toThrow(ZodError);
    await expect(
      service.registerDemoRequest('c1', 'ctx1', 'barbershop', {
        customerName: '  ',
      }),
    ).rejects.toThrow(ZodError);
    expect(create).not.toHaveBeenCalled();
  });
});

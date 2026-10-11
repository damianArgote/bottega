import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Dummy env values for the e2e run are provided in vitest.config.e2e.ts.
// PrismaService is replaced so no real database is needed.
describe('GET /health (e2e)', () => {
  const queryRaw = vi.fn();
  let app: INestApplication<App>;

  beforeEach(async () => {
    queryRaw.mockReset();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ $queryRaw: queryRaw })
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with db up', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', db: 'up' });
  });

  it('returns 503 with db down', async () => {
    queryRaw.mockRejectedValue(new Error('connection refused'));

    await request(app.getHttpServer())
      .get('/health')
      .expect(503)
      .expect({ status: 'error', db: 'down' });
  });
});

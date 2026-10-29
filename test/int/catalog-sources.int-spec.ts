import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import {
  AI_PROVIDER,
  type AiProvider,
  type AiResponse,
} from '../../src/ai/ai.provider.js';
import { usageDay } from '../../src/ai/ai-usage.service.js';
import { configureHttp } from '../../src/app.setup.js';
import {
  SHEET_FETCHER,
  type SheetFetcher,
} from '../../src/catalog/sheet-fetcher.js';
import { AppModule } from '../../src/app.module.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createLine, resetDb, testConfig } from './helpers.js';

const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';

const answer = (outputText: string): AiResponse => ({
  outputText,
  toolCalls: [],
  usage: { inputTokens: 50, outputTokens: 20 },
  model: 'test-model',
});

const SHEET = [
  'Cód,Sabor,Precio x kg,Hay,Notas',
  'A1,Chocolate amargo,"15.000",sí,intenso',
  'A2,Dulce de leche,14000,no,',
].join('\n');

const AI_MAPPING_CONFIRMED = {
  externalId: 'Cód',
  name: 'Sabor',
  price: 'Precio x kg',
  available: 'Hay',
};

const AI_MAPPING = {
  externalId: 'Cód',
  name: 'Sabor',
  description: null,
  category: null,
  price: 'Precio x kg',
  currency: null,
  available: 'Hay',
};

type ImportBody = {
  id: string;
  status: string;
  source: string;
  mapping: Record<string, string> | null;
  mappingConfirmed: boolean;
  headers: string[] | null;
  summary: Record<string, number>;
  errors: { row: number; message: string }[];
};

describe('Catalog sources: AI mapping and documents (integration, HTTP)', () => {
  const respond = vi.fn<AiProvider['respond']>();
  const fetchSheet = vi.fn<SheetFetcher>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let a: string;

  beforeAll(async () => {
    const config = testConfig({
      BOT_REPLY_MODE: 'ai',
      OPENAI_API_KEY: 'unused',
      OPENAI_MODEL: 'test-model',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppConfigService)
      .useValue(config)
      .overrideProvider(AI_PROVIDER)
      .useValue({ respond })
      .overrideProvider(SHEET_FETCHER)
      .useValue(fetchSheet)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, config);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    respond.mockReset();
    fetchSheet.mockReset();
    a = (await createLine(prisma, { slug: 'kubbo', phoneNumberId: '222' }))
      .businessId;
  });

  const http = () => request(app.getHttpServer());
  const admin = (path: string) => `/admin/businesses/${a}/catalog/${path}`;
  const postCsv = (csv: string, query = '') =>
    http()
      .post(`${admin('imports')}${query}`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .set('Content-Type', 'text/csv')
      .send(csv);
  const apply = (id: string) =>
    http()
      .post(admin(`imports/${id}/apply`))
      .set('X-Admin-Api-Key', ADMIN_KEY);
  const confirm = (id: string, mapping: object) =>
    http()
      .put(admin(`imports/${id}/mapping`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ mapping });

  it('the model proposes the mapping; apply waits for a person to confirm it', async () => {
    respond.mockResolvedValueOnce(answer(JSON.stringify(AI_MAPPING)));

    const preview = (await postCsv(SHEET).expect(201)).body as ImportBody;

    expect(preview).toMatchObject({
      mappingConfirmed: false,
      headers: ['Cód', 'Sabor', 'Precio x kg', 'Hay', 'Notas'],
      mapping: {
        externalId: 'Cód',
        name: 'Sabor',
        price: 'Precio x kg',
        available: 'Hay',
      },
      summary: { created: 2, errors: 0 },
    });
    // The model saw the headers and up to 5 sample rows, as strict JSON.
    const sent = respond.mock.calls[0]![0];
    expect(sent.responseFormat?.name).toBe('catalog_mapping');
    expect(JSON.stringify(sent.input)).toContain('Precio x kg');
    const res = await apply(preview.id).expect(409);
    expect(res.body).toMatchObject({ code: 'MAPPING_NOT_CONFIRMED' });
    expect(await prisma.catalogItem.count()).toBe(0);
  });

  it('a person corrects the mapping: rows are normalized again, it is saved and reused without the model', async () => {
    respond.mockResolvedValueOnce(answer(JSON.stringify(AI_MAPPING)));
    const preview = (await postCsv(SHEET).expect(201)).body as ImportBody;

    const corrected = (
      await confirm(preview.id, {
        externalId: 'Cód',
        name: 'Sabor',
        price: 'Precio x kg',
        description: 'Notas',
      }).expect(200)
    ).body as ImportBody;
    expect(corrected).toMatchObject({ mappingConfirmed: true });
    await apply(preview.id).expect(200);
    const stored = await prisma.catalogItem.findMany({
      orderBy: { externalId: 'asc' },
    });
    expect(
      stored.map((i) => [
        i.name,
        i.description,
        i.price?.toFixed(2),
        i.available,
      ]),
    ).toEqual([
      ['Chocolate amargo', 'intenso', '15000.00', true],
      // "Hay" is no longer the availability: it went to attributes.
      ['Dulce de leche', '', '14000.00', true],
    ]);
    expect(stored[1]?.attributes).toEqual({ Hay: 'no' });

    // Same headers, other order: the saved mapping, no model call.
    const reordered = [
      'Sabor,Cód,Notas,Precio x kg,Hay',
      'Chocolate amargo,A1,intenso,16000,sí',
    ].join('\n');
    const second = (await postCsv(reordered).expect(201)).body as ImportBody;
    expect(respond).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      mappingConfirmed: true,
      mapping: { name: 'Sabor', description: 'Notas' },
    });
    await apply(second.id).expect(200);
  });

  it('a mapping sent by a person is saved and confirmed; new headers ask the model again', async () => {
    await postCsv(
      SHEET,
      `?mapping=${encodeURIComponent(JSON.stringify({ name: 'Sabor', price: 'Precio x kg' }))}`,
    ).expect(201);
    expect(respond).not.toHaveBeenCalled();
    const business = await prisma.business.findUniqueOrThrow({
      where: { id: a },
    });
    expect(business.catalogMapping).toEqual({
      headers: ['Cód', 'Sabor', 'Precio x kg', 'Hay', 'Notas'],
      mapping: { name: 'Sabor', price: 'Precio x kg' },
    });

    respond.mockResolvedValueOnce(
      answer(
        JSON.stringify({
          ...AI_MAPPING,
          externalId: null,
          available: null,
          name: 'Gusto',
          price: 'Valor kg',
        }),
      ),
    );
    await postCsv('Gusto,Valor kg\nTorta,9000').expect(201);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('known name and price columns need no model and no confirmation', async () => {
    const preview = (
      await postCsv(
        'codigo,producto,precio,sabor\nA1,Torta,100,frutilla',
      ).expect(201)
    ).body as ImportBody;

    expect(respond).not.toHaveBeenCalled();
    expect(preview).toMatchObject({
      mappingConfirmed: true,
      mapping: { externalId: 'codigo', name: 'producto', price: 'precio' },
    });
    await apply(preview.id).expect(200);
    expect((await prisma.catalogItem.findFirstOrThrow()).attributes).toEqual({
      sabor: 'frutilla',
    });
  });

  it('an invalid proposal (a column that does not exist) falls back to the known headers', async () => {
    respond.mockResolvedValueOnce(
      answer(JSON.stringify({ ...AI_MAPPING, name: 'Nombre inventado' })),
    );

    const preview = (
      await postCsv('codigo,producto,costo\nA1,Torta,100').expect(201)
    ).body as ImportBody;

    expect(respond).toHaveBeenCalledTimes(1);
    expect(preview).toMatchObject({
      mappingConfirmed: true,
      mapping: { externalId: 'codigo', name: 'producto' },
    });
  });

  it('records each catalog call apart and counts it in the monthly cap; at the cap the model is not called', async () => {
    respond.mockResolvedValue(answer(JSON.stringify(AI_MAPPING)));
    await prisma.business.update({
      where: { id: a },
      data: { aiMonthlyCap: 1 },
    });

    await postCsv(SHEET).expect(201);
    expect(await prisma.catalogAiUsage.findMany()).toEqual([
      expect.objectContaining({
        businessId: a,
        purpose: 'mapping',
        outcome: 'OK',
        inputTokens: 50,
        outputTokens: 20,
        day: usageDay(new Date()),
      }),
    ]);
    await http()
      .get(`/admin/businesses/${a}/usage`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200)
      .expect((res) =>
        expect(res.body).toMatchObject({ used: 1, capReached: true }),
      );

    // Cap reached: known headers instead of the model, and no document reading.
    const preview = (
      await postCsv('Cód,producto,precio\nX,Torta,1').expect(201)
    ).body as ImportBody;
    expect(preview).toMatchObject({ mappingConfirmed: true });
    const pdf = await http()
      .post(admin('imports'))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('%PDF-1.4 lista'))
      .expect(409);
    expect(pdf.body).toMatchObject({ code: 'AI_CAP_REACHED' });
    expect(respond).toHaveBeenCalledTimes(1);
  });

  describe('a sheet whose mapping waits for a person', () => {
    const URL =
      'https://docs.google.com/spreadsheets/d/e/2PACX-kubbo/pub?output=csv';
    const sync = () =>
      http().post(admin('sync')).set('X-Admin-Api-Key', ADMIN_KEY);

    beforeEach(async () => {
      await http()
        .put(admin('sheet'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ url: URL })
        .expect(200);
      respond.mockResolvedValue(answer(JSON.stringify(AI_MAPPING)));
    });

    it('an unchanged sheet keeps the same preview and does not ask the model again', async () => {
      fetchSheet.mockResolvedValue(SHEET);

      const first = (await sync().expect(200)).body as {
        outcome: string;
        import: ImportBody;
      };
      expect(first).toMatchObject({
        outcome: 'preview',
        import: { mappingConfirmed: false },
      });
      const second = (await sync().expect(200)).body as {
        outcome: string;
        import: ImportBody;
      };

      expect(second.import.id).toBe(first.import.id);
      expect(respond).toHaveBeenCalledTimes(1);
      expect(await prisma.catalogAiUsage.count()).toBe(1);
      // The person can still confirm the preview they were looking at.
      await confirm(first.import.id, AI_MAPPING_CONFIRMED).expect(200);
      await apply(first.import.id).expect(200);
      expect(await prisma.catalogItem.count()).toBe(2);
    });

    it('changed rows with the same headers reuse the pending proposal', async () => {
      fetchSheet.mockResolvedValueOnce(SHEET);
      await sync().expect(200);
      fetchSheet.mockResolvedValueOnce(`${SHEET}\nA3,Limón,12000,sí,`);

      const second = (await sync().expect(200)).body as {
        import: ImportBody;
      };

      expect(respond).toHaveBeenCalledTimes(1);
      expect(second.import).toMatchObject({
        mappingConfirmed: false,
        mapping: { name: 'Sabor', price: 'Precio x kg' },
        summary: { created: 3 },
      });
    });
  });

  describe('PDF and photos', () => {
    const extraction = {
      rows: [
        {
          codigo: null,
          producto: 'Chocolate amargo',
          descripcion: 'Cacao 70%',
          categoria: 'Helados',
          precio: '$ 15.000',
          disponible: null,
        },
        {
          codigo: null,
          producto: 'Limón',
          descripcion: null,
          categoria: 'Helados',
          precio: 'consultar',
          disponible: null,
        },
      ],
    };
    const postDocument = (type: string, data = Buffer.from('%PDF-1.4 lista')) =>
      http()
        .post(admin('imports'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .set('Content-Type', type)
        .send(data);

    it('a PDF becomes a preview that is never applied by itself', async () => {
      respond.mockResolvedValueOnce(answer(JSON.stringify(extraction)));

      const preview = (await postDocument('application/pdf').expect(201))
        .body as ImportBody;

      expect(preview).toMatchObject({
        status: 'PREVIEW',
        source: 'document',
        summary: { created: 1, errors: 1 },
        errors: [
          { row: 2, message: 'Fila 2: el precio "consultar" no es un número.' },
        ],
      });
      expect(await prisma.catalogItem.count()).toBe(0);
      const sent = respond.mock.calls[0]![0];
      expect(sent.responseFormat?.name).toBe('catalog_rows');
      expect(sent.input[0]).toMatchObject({
        kind: 'parts',
        content: [
          {
            kind: 'file',
            dataUrl: expect.stringMatching(
              /^data:application\/pdf;base64,/,
            ) as unknown,
          },
        ],
      });
      expect(
        await prisma.catalogAiUsage.count({ where: { purpose: 'extraction' } }),
      ).toBe(1);

      // A person applies it.
      await apply(preview.id).expect(200);
      expect(
        (await prisma.catalogItem.findFirstOrThrow()).price?.toFixed(2),
      ).toBe('15000.00');
    });

    it('a photo goes as an image; an unusable answer gives 422 and stores nothing', async () => {
      respond.mockResolvedValueOnce(answer('{"rows": [ {"producto": "Tor'));

      const res = await postDocument(
        'image/jpeg',
        Buffer.from([0xff, 0xd8, 0xff]),
      ).expect(422);

      expect(res.body).toMatchObject({ code: 'DOCUMENT_UNREADABLE' });
      expect(respond.mock.calls[0]![0].input[0]).toMatchObject({
        content: [{ kind: 'image' }],
      });
      expect(await prisma.catalogImport.count()).toBe(0);
    });

    it('a document has no mapping to confirm', async () => {
      respond.mockResolvedValueOnce(answer(JSON.stringify(extraction)));
      const preview = (await postDocument('application/pdf').expect(201))
        .body as ImportBody;

      await confirm(preview.id, { name: 'producto' }).expect(409);
    });
  });
});

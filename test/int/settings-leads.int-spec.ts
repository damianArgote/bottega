import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { AgentsService } from '../../src/agents/agents.service.js';
import { configureHttp } from '../../src/app.setup.js';
import { AppModule } from '../../src/app.module.js';
import { LOGIN_RATE_LIMITER } from '../../src/auth/login-rate-limiter.js';
import { UsersService } from '../../src/auth/users.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createLine, resetDb } from './helpers.js';

const PASSWORD = 'una clave larga';

interface LeadItem {
  id: string;
  data: Record<string, string>;
  createdAt: string;
  contact: { waId: string; profileName: string | null };
  conversation: { id: string };
}
type ListBody = { leads: LeadItem[]; nextCursor: string | null };

describe('Backoffice leads (integration, HTTP)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let users: UsersService;
  let a: { businessId: string; lineId: string };
  let b: { businessId: string; lineId: string };
  let owner: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOGIN_RATE_LIMITER)
      .useValue({ attempt: () => true })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, app.get(AppConfigService));
    await app.init();
    prisma = app.get(PrismaService);
    users = app.get(UsersService);
  });

  afterAll(async () => {
    await app.close();
  });

  let waSeq = 0;
  /** A contact, its conversation and its lead, created at `at`. */
  const lead = async (
    business: { businessId: string; lineId: string },
    at: string,
    data: Record<string, string>,
    profileName: string | null = 'Alberto',
  ) => {
    waSeq += 1;
    const contact = await prisma.contact.create({
      data: {
        businessId: business.businessId,
        waId: `54911000${String(waSeq).padStart(5, '0')}`,
        profileName,
      },
    });
    const conversation = await prisma.conversation.create({
      data: { lineId: business.lineId, contactId: contact.id },
    });
    return prisma.lead.create({
      data: {
        businessId: business.businessId,
        conversationId: conversation.id,
        data,
        createdAt: new Date(at),
      },
    });
  };

  beforeEach(async () => {
    await resetDb(prisma);
    a = await createLine(prisma, { slug: 'lola', phoneNumberId: '222' });
    b = await createLine(prisma, { slug: 'kubbo', phoneNumberId: '333' });
    await app.get(AgentsService).put(a.businessId, {
      enabled: true,
      botName: 'Lola',
      persona: '',
      businessInfo: '',
      faq: [],
      leadFields: [
        { key: 'name', label: 'Nombre', required: true, kind: 'text' },
        {
          key: 'business_name',
          label: 'Negocio',
          required: false,
          kind: 'text',
        },
      ],
      handoffRules: '',
      outOfHoursMessage: null,
      openingHours: null,
      model: null,
      demoEnabled: false,
    });
    for (const [email, role, businessId] of [
      ['olga@example.com', 'OWNER', a.businessId],
      ['ana@example.com', 'AGENT', a.businessId],
    ] as const) {
      await users.addToBusiness(businessId, {
        email,
        name: email,
        password: PASSWORD,
        role,
      });
    }
    owner = await sessionOf('olga@example.com');
  });

  const http = () => request(app.getHttpServer());

  async function sessionOf(email: string) {
    const res = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    const lines = res.headers['set-cookie'] as unknown as string[];
    return lines.find((l) => l.startsWith('bottega_session='))!.split(';')[0]!;
  }

  const list = (
    query: Record<string, string> = {},
    businessId = a.businessId,
  ) =>
    http()
      .get(`/inbox/businesses/${businessId}/leads`)
      .query(query)
      .set('Cookie', owner);
  const exportCsv = (
    query: Record<string, string> = {},
    businessId = a.businessId,
  ) =>
    http()
      .get(`/inbox/businesses/${businessId}/leads/export.csv`)
      .query(query)
      .set('Cookie', owner);

  it('an AGENT gets 403 on the leads and the export', async () => {
    await lead(a, '2026-10-25T12:00:00Z', { name: 'Alberto' });
    const agent = await sessionOf('ana@example.com');

    await http()
      .get(`/inbox/businesses/${a.businessId}/leads`)
      .set('Cookie', agent)
      .expect(403);
    const res = await http()
      .get(`/inbox/businesses/${a.businessId}/leads/export.csv`)
      .set('Cookie', agent)
      .expect(403);
    expect(res.text).not.toContain('Alberto');
  });

  it("an OWNER of business A never sees business B's leads", async () => {
    await lead(a, '2026-10-25T12:00:00Z', { name: 'De A' });
    await lead(b, '2026-10-25T12:00:00Z', { name: 'De B' });

    const res = await list().expect(200);
    expect((res.body as ListBody).leads.map((l) => l.data.name)).toEqual([
      'De A',
    ]);
    expect((await exportCsv().expect(200)).text).not.toContain('De B');
    await list({}, b.businessId).expect(403);
    await exportCsv({}, b.businessId).expect(403);
  });

  it('lists 50 per page, newest first, with the contact and the conversation', async () => {
    const created = [];
    for (let i = 0; i < 53; i += 1) {
      // Pairs share a timestamp: the id breaks the tie.
      const at = new Date(Date.UTC(2026, 9, 1, 12, Math.floor(i / 2)));
      created.push(await lead(a, at.toISOString(), { name: `L${i}` }));
    }
    const expected = created
      .sort(
        (x, y) =>
          y.createdAt.getTime() - x.createdAt.getTime() ||
          (y.id > x.id ? 1 : -1),
      )
      .map((l) => l.id);

    const first = (await list().expect(200)).body as ListBody;
    expect(first.leads).toHaveLength(50);
    expect(first.leads[0]).toMatchObject({
      contact: { profileName: 'Alberto' },
      conversation: { id: expect.any(String) as unknown },
    });
    const second = (await list({ cursor: first.nextCursor! }).expect(200))
      .body as ListBody;

    expect(second.nextCursor).toBeNull();
    expect([...first.leads, ...second.leads].map((l) => l.id)).toEqual(
      expected,
    );
  });

  it('from and to are days in the business timezone, to included', async () => {
    // 2026-10-25 02:30 UTC is still the 24th in Buenos Aires (UTC-3).
    await lead(a, '2026-10-25T02:30:00Z', { name: 'Noche del 24' });
    await lead(a, '2026-10-25T03:30:00Z', { name: 'Madrugada del 25' });
    await lead(a, '2026-10-26T02:59:00Z', { name: 'Fin del 25' });
    const names = async (query: Record<string, string>) =>
      ((await list(query).expect(200)).body as ListBody).leads.map(
        (l) => l.data.name,
      );

    expect(await names({ from: '2026-10-25', to: '2026-10-25' })).toEqual([
      'Fin del 25',
      'Madrugada del 25',
    ]);
    expect(await names({ to: '2026-10-24' })).toEqual(['Noche del 24']);
    const csv = (
      await exportCsv({ from: '2026-10-24', to: '2026-10-24' }).expect(200)
    ).text;
    expect(csv).toContain('Noche del 24');
    expect(csv).not.toContain('del 25');
  });

  it('q finds by contact name or number or by any lead value, literally', async () => {
    const byName = await lead(a, '2026-10-25T12:00:00Z', {}, 'Kubbo Helados');
    const byValue = await lead(a, '2026-10-25T12:01:00Z', {
      business_name: 'Heladería 100% artesanal',
    });
    await lead(a, '2026-10-25T12:02:00Z', { name: 'Otro' }, 'Otro');
    const ids = async (q: string) =>
      ((await list({ q }).expect(200)).body as ListBody).leads.map((l) => l.id);
    const contact = await prisma.contact.findFirstOrThrow({
      where: { profileName: 'Kubbo Helados' },
    });

    expect(await ids('kubbo')).toEqual([byName.id]);
    expect(await ids(contact.waId.slice(-5))).toEqual([byName.id]);
    expect(await ids('HELADERÍA')).toEqual([byValue.id]);
    expect(await ids('100%')).toEqual([byValue.id]);
    expect(await ids('1_0')).toEqual([]);
  });

  it('rejects a bad range, an unknown parameter or a bad cursor with 400', async () => {
    await list({ from: '2026-10-26', to: '2026-10-25' }).expect(400);
    await list({ from: '2026-13-01' }).expect(400);
    await list({ status: 'NEW' }).expect(400);
    await list({ cursor: 'nope' }).expect(400);
    await exportCsv({ from: '2026-10-26', to: '2026-10-25' }).expect(400);
    await exportCsv({ q: 'x' }).expect(400);
  });

  it("exports the business's lead fields, date, profile name and phone, with formulas neutralized", async () => {
    await lead(a, '2026-10-25T15:04:00Z', {
      name: '=SUM(A1)',
      business_name: 'Dijo "hola"',
    });

    const res = await exportCsv({
      from: '2026-10-25',
      to: '2026-10-25',
    }).expect(200);

    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="leads-2026-10-25_2026-10-25.csv"',
    );
    const contact = await prisma.contact.findFirstOrThrow({
      where: { businessId: a.businessId },
    });
    expect(res.text).toBe(
      '\uFEFF"Nombre","Negocio","Fecha","Nombre de perfil","Teléfono"\r\n' +
        `"'=SUM(A1)","Dijo ""hola""","2026-10-25 12:04","Alberto","${contact.waId}"\r\n`,
    );
  });
});

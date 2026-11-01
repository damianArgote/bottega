import { createHmac } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { ACTION_FETCH } from '../../src/actions/action-caller.service.js';
import { configureHttp } from '../../src/app.setup.js';
import { AppModule } from '../../src/app.module.js';
import { UsersService } from '../../src/auth/users.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { createSafeFetch } from '../../src/integrations/safe-fetch.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createLine, resetDb } from './helpers.js';

// Must match ADMIN_API_KEY in vitest.config.int.ts.
const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';
const PASSWORD = 'una clave larga';
const URL = 'https://n8n.example.com/webhook/stock';

interface ActionBody {
  id: string;
  name: string;
  kind: string;
  secret?: string;
}

const stockAction = {
  name: 'consultar_stock',
  description: 'Consulta el stock de un producto en la tienda.',
  parameters: {
    properties: { producto: { type: 'string', maxLength: 80 } },
    required: ['producto'],
  },
  url: URL,
  kind: 'query',
};

describe('Business actions: setup routes (integration)', () => {
  const actionFetch = vi.fn<typeof fetch>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let businessId: string;
  let otherBusinessId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ACTION_FETCH)
      .useValue(actionFetch)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, app.get(AppConfigService));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    actionFetch.mockReset();
    actionFetch.mockImplementation(() =>
      Promise.resolve(
        Response.json({ reply: 'Hay 3 en stock.', data: { stock: 3 } }),
      ),
    );
    businessId = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    otherBusinessId = (
      await createLine(prisma, { slug: 'otro', phoneNumberId: '999000' })
    ).businessId;
  });

  const http = () => request(app.getHttpServer());
  const admin = (path = '', business = businessId) =>
    `/admin/businesses/${business}/actions${path}`;
  const create = async (body: object = stockAction, business = businessId) =>
    (
      await http()
        .post(admin('', business))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send(body)
        .expect(201)
    ).body as ActionBody;

  it('creates an action with its secret shown once, encrypted at rest and never listed', async () => {
    const created = await create();

    expect(created).toMatchObject({
      name: 'consultar_stock',
      kind: 'query',
      timeoutMs: 5000,
      active: true,
    });
    expect(created.secret).toMatch(/^whsec_/);
    const stored = await prisma.agentAction.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.secretEncrypted).not.toContain(created.secret!);
    const list = await http()
      .get(admin())
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('whsec_');
    expect(JSON.stringify(list.body)).not.toContain('secretEncrypted');
  });

  it('validates the action: snake_case unique name, not a built-in tool, https, parameters, timeout up to 10 s', async () => {
    await create();
    await http()
      .post(admin())
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send(stockAction)
      .expect(409);
    for (const bad of [
      { ...stockAction, name: 'Consultar-Stock' },
      { ...stockAction, name: 'search_catalog' },
      { ...stockAction, name: 'otra', url: 'http://n8n.example.com/x' },
      { ...stockAction, name: 'otra', timeoutMs: 10_001 },
      { ...stockAction, name: 'otra', kind: 'write' },
      {
        ...stockAction,
        name: 'otra',
        parameters: { properties: { a: { type: 'string' } } },
      },
      { ...stockAction, name: 'otra', secret: 'mine' },
    ]) {
      await http()
        .post(admin())
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send(bad)
        .expect(400);
    }
    // The same name is free in another business.
    await create(stockAction, otherBusinessId);
  });

  it('edits, rotates the secret and deletes, only within the business', async () => {
    const created = await create();
    const foreign = await create(stockAction, otherBusinessId);

    const edited = await http()
      .patch(admin(`/${created.id}`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ active: false, kind: 'effect', timeoutMs: 10_000 })
      .expect(200);
    expect(edited.body).toMatchObject({
      active: false,
      kind: 'effect',
      timeoutMs: 10_000,
    });
    const rotated = await http()
      .post(admin(`/${created.id}/rotate-secret`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200);
    expect((rotated.body as ActionBody).secret).toMatch(/^whsec_/);
    expect((rotated.body as ActionBody).secret).not.toBe(created.secret);

    for (const path of [`/${foreign.id}/rotate-secret`, `/${foreign.id}/test`]) {
      await http()
        .post(admin(path))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ arguments: { producto: 'remera' } })
        .expect(404);
    }
    await http()
      .patch(admin(`/${foreign.id}`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ active: false })
      .expect(404);
    await http()
      .delete(admin(`/${foreign.id}`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(404);
    await http()
      .delete(admin(`/${created.id}`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(204);
    expect(await prisma.agentAction.count()).toBe(1);
  });

  it('"probar" calls it signed, with example arguments and test: true, and shows the answer', async () => {
    const created = await create();

    const res = await http()
      .post(admin(`/${created.id}/test`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ arguments: { producto: ' remera  azul ' } })
      .expect(200);

    expect(res.body).toEqual({
      ok: true,
      status: 200,
      reply: 'Hay 3 en stock.',
      data: { stock: 3 },
    });
    expect(actionFetch).toHaveBeenCalledTimes(1);
    const [url, init] = actionFetch.mock.calls[0]!;
    expect(url).toBe(URL);
    const headers = init!.headers as Record<string, string>;
    const body = init!.body as string;
    expect(JSON.parse(body)).toMatchObject({
      action: 'consultar_stock',
      businessId,
      conversationId: null,
      contact: null,
      arguments: { producto: 'remera azul' },
      test: true,
    });
    expect(headers['X-Bottega-Idempotency-Key']).toMatch(/^test:/);
    const expected = createHmac('sha256', created.secret!)
      .update(`${headers['X-Bottega-Timestamp']}.${body}`)
      .digest('hex');
    expect(headers['X-Bottega-Signature']).toBe(`sha256=${expected}`);
    // Not a bot call: nothing recorded.
    expect(await prisma.agentActionCall.count()).toBe(0);
  });

  it('"probar" does not call with invalid arguments, and reports failures by code', async () => {
    const created = await create();

    const invalid = await http()
      .post(admin(`/${created.id}/test`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ arguments: { producto: 'x'.repeat(81) } })
      .expect(200);
    expect(invalid.body).toMatchObject({ ok: false });
    expect((invalid.body as { error: string }).error).toMatch(
      /^invalid_arguments/,
    );
    expect(actionFetch).not.toHaveBeenCalled();

    actionFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response('boom', { status: 500 })),
    );
    const failed = await http()
      .post(admin(`/${created.id}/test`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ arguments: { producto: 'remera' } })
      .expect(200);
    expect(failed.body).toEqual({ ok: false, status: 500, error: 'http_500' });

    // A host that resolves to a private address is never called.
    const resolve = vi.fn(() =>
      Promise.resolve([{ address: '169.254.169.254', family: 4 }]),
    );
    const connect = vi.fn();
    actionFetch.mockImplementationOnce(
      createSafeFetch({ maxResponseBytes: 8192 }, { resolve, request: connect }),
    );
    const blocked = await http()
      .post(admin(`/${created.id}/test`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ arguments: { producto: 'remera' } })
      .expect(200);
    expect(blocked.body).toEqual({
      ok: false,
      status: null,
      error: 'blocked_address',
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('staff manages actions; the owner only reads them', async () => {
    const created = await create();
    const users = app.get(UsersService);
    const { user } = await users.addToBusiness(businessId, {
      email: 'olga@example.com',
      name: 'Olga',
      password: PASSWORD,
      role: 'OWNER',
    });
    const login = async () => {
      const res = await http()
        .post('/auth/login')
        .send({ email: 'olga@example.com', password: PASSWORD })
        .expect(200);
      return (res.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('bottega_session='))!
        .split(';')[0]!;
    };
    const staffPath = `/staff/businesses/${businessId}/actions`;
    const ownerPath = `/inbox/businesses/${businessId}/settings/actions`;

    await http().get(admin()).expect(401);
    const owner = await login();
    const read = await http().get(ownerPath).set('Cookie', owner).expect(200);
    expect(read.body).toMatchObject([{ id: created.id }]);
    expect(JSON.stringify(read.body)).not.toContain('whsec_');
    await http().get(staffPath).set('Cookie', owner).expect(403);
    await http()
      .patch(`${ownerPath}/${created.id}`)
      .set('Cookie', owner)
      .send({ active: false })
      .expect(404);
    await http()
      .get(`/inbox/businesses/${otherBusinessId}/settings/actions`)
      .set('Cookie', owner)
      .expect(403);

    await http()
      .put(`/admin/users/${user.id}/staff`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ staff: true })
      .expect(200);
    const staff = await login();
    const res = await http()
      .post(staffPath)
      .set('Cookie', staff)
      .send({ ...stockAction, name: 'reservar_turno', kind: 'effect' })
      .expect(201);
    expect((res.body as ActionBody).secret).toMatch(/^whsec_/);
    await http()
      .post(`${staffPath}/${created.id}/test`)
      .set('Cookie', staff)
      .send({ arguments: { producto: 'remera' } })
      .expect(200);
  });
});

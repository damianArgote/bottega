import { ConflictException, NotFoundException } from '@nestjs/common';
import { PasswordHasher } from '../../src/auth/password-hasher.js';
import { UsersService } from '../../src/auth/users.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { connectPrisma, createLine, resetDb } from './helpers.js';

describe('Users and memberships (integration)', () => {
  let prisma: PrismaService;
  let users: UsersService;
  const hasher = new PasswordHasher();
  let a: string;
  let b: string;

  beforeAll(async () => {
    prisma = await connectPrisma();
    users = new UsersService(prisma, hasher);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    a = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    b = (await createLine(prisma, { slug: 'lola', phoneNumberId: '222' }))
      .businessId;
  });

  const input = {
    email: ' Ana@Example.COM ',
    name: 'Ana',
    password: 'una clave larga',
    role: 'OWNER' as const,
  };

  it('creates the user with a lowercased email and an argon2id hash, and the membership', async () => {
    const result = await users.addToBusiness(a, input);

    expect(result).toEqual({
      user: {
        id: expect.any(String) as unknown,
        email: 'ana@example.com',
        name: 'Ana',
        active: true,
      },
      membership: { businessId: a, role: 'OWNER' },
      createdUser: true,
    });
    const stored = await prisma.user.findUniqueOrThrow({
      where: { email: 'ana@example.com' },
    });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await hasher.verify(stored.passwordHash, 'una clave larga')).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toContain('passwordHash');
  });

  it('adds an existing user to another business without changing their password or name', async () => {
    await users.addToBusiness(a, input);
    const before = await prisma.user.findFirstOrThrow();

    const result = await users.addToBusiness(b, {
      ...input,
      email: 'ana@example.com',
      name: 'Otro nombre',
      password: 'otra clave distinta',
      role: 'AGENT',
    });

    expect(result).toMatchObject({
      membership: { businessId: b, role: 'AGENT' },
      createdUser: false,
      user: { name: 'Ana' },
    });
    const after = await prisma.user.findFirstOrThrow();
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.membership.count()).toBe(2);
  });

  it('409s when the user already belongs to the business', async () => {
    await users.addToBusiness(a, input);

    await expect(users.addToBusiness(a, input)).rejects.toThrow(
      ConflictException,
    );
    expect(await prisma.membership.count()).toBe(1);
  });

  it('404s for an unknown business and creates nothing', async () => {
    await expect(
      users.addToBusiness('00000000-0000-4000-8000-000000000000', input),
    ).rejects.toThrow(NotFoundException);
    expect(await prisma.user.count()).toBe(0);
  });

  it('keeps one user per email, whatever the case', async () => {
    await users.addToBusiness(a, input);
    await expect(
      prisma.$executeRaw`INSERT INTO app_user (id, email, password_hash, name, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'ana@example.com', 'x', 'Ana', true, now(), now())`,
    ).rejects.toThrow(/unique/i);
  });
});

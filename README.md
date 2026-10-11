# bottega-api

Backend (NestJS + TypeScript) del bot comercial de WhatsApp de Bottega y sus demos
interactivas. Usa la API oficial de WhatsApp Cloud, OpenAI y PostgreSQL (Prisma).

> Estado: Etapa 1 (base del proyecto, base de datos y configuración).
> La guía completa (incluida la configuración de Meta y WSL) llega en la Etapa 5.

## Requisitos

- Node.js >= 22.22.3 (recomendado Node 24 LTS, ver `.nvmrc`)
- npm
- Docker con `docker compose`

## Puesta en marcha local

```bash
npm install
npm run db:up              # levanta PostgreSQL (credenciales solo para desarrollo)
cp .env.example .env       # completar los valores `replace-me`
npm run prisma:migrate     # aplica las migraciones a la base local
npm run start:dev
curl localhost:3000/health # {"status":"ok","db":"up"}
```

Si falta una variable obligatoria o tiene un formato inválido, la aplicación no
arranca y muestra qué variable falla (nunca su valor).

## Scripts útiles

| Script                              | Descripción                                        |
| ----------------------------------- | -------------------------------------------------- |
| `npm run build`                     | Compila a `dist/`                                  |
| `npm run lint`                      | ESLint                                             |
| `npm test`                          | Tests unitarios (Vitest)                           |
| `npm run test:e2e`                  | Tests e2e (sin red ni base real)                   |
| `npm run prisma:generate`           | Genera el cliente Prisma en `src/generated/prisma` |
| `npm run prisma:migrate`            | `prisma migrate dev` (desarrollo)                  |
| `npm run prisma:deploy`             | `prisma migrate deploy` (producción)               |
| `npm run db:up` / `npm run db:down` | Levanta / detiene PostgreSQL                       |

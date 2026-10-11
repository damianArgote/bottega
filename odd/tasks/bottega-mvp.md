# Feature: bottega-mvp

## Objective
Build bottega-api: a NestJS + TypeScript backend for our own WhatsApp commercial bot and interactive demos, using the official WhatsApp Cloud API, OpenAI, and PostgreSQL (Prisma).

## Problem / Why
We need our own WhatsApp bot to attend prospects and showcase demos, without BuilderBot/QR-based libraries, testable end to end with the Meta test number.

## Scope
Modules: whatsapp, ai, conversations, leads, demos, health (+ queue, bot worker, admin). Out of scope: frontend, flow editor, billing, multi-tenant, Redis, distributed infra, LangChain/LangGraph.

## Constraints
- NestJS 12, strict TypeScript, npm, Node >= 22.22.3 (Node 24 LTS recommended).
- Prisma pinned to ^7 (npm `latest` is 8.0.0-rc without schema.prisma/migrate dev). prisma.config.ts + @prisma/adapter-pg.
- Graph API version, tokens, phone number id from env; default example v26.0.
- OpenAI official SDK (Responses API), model via OPENAI_MODEL (placeholder, no hardcoded id).
- No secrets in git, logs, or chat. Tests use mocks for Meta/OpenAI.

## Architecture decisions (approved 2026-10-11)
- Modular monolith; ports only for WhatsAppClient and AiProvider (adapters). PrismaService used directly, no repositories.
- ModeProfile data map (commercial/demo) instead of State pattern; deterministic commands via Map + matchCommand; `planTransition` is the only gate for mode/pause/context changes; model text never triggers transitions.
- Lightweight tool registry (zod .strict(), allowedModes); user-facing action confirmations built from real ToolOutcome.
- PG queue: ProcessingJob with lease, CTE `UPDATE ... FOR UPDATE SKIP LOCKED`, partial unique index `(conversation_id) WHERE status='processing'`, head-of-conversation ordering, exponential backoff, bounded attempts.
- Two-phase job: generate + persist outbound `queued` messages with idempotencyKey (with tool effects, same tx), then send. Uncertain sends are marked `uncertain` and never auto-resent (at-most-once).
- ConversationContext table + Message.contextId isolates commercial/demo history. "reiniciar" closes active context and opens a new one; nothing is deleted.
- "reiniciar" KEEPS collected lead data (user decision 2026-10-11); lead data injected into commercial prompt from Lead, never into demo.
- AiUsage table for daily per-user cap and usage logging (no content).
- Assumption (pending confirmation): while paused, all inbound messages (including commands) are stored without auto-reply; admin resumes.

## Delivery strategy
ask-on-risk. Forecast > 400 authored lines overall; chain strategy to be asked before the first PR. Work-unit commits on branch `feat/bottega-mvp`.

## Tasks
- [x] T1 — Stage 1: project, database, and configuration (NestJS scaffold, strict TS, lint/test scripts, Docker Compose PG, Prisma 7 schema for all entities + initial migration, env validation at boot, .env.example, .gitignore, health module). Route: delegated (writer trigger: 2+ non-trivial files).
- [ ] T2 — Stage 2: webhook GET verify + POST signature validation + payload parsing + fixed echo reply (BOT_REPLY_MODE=echo).
- [ ] T3 — Stage 3: persistence, PG job queue, deduplication, worker, uncertain-send handling.
- [ ] T4 — Stage 4: AI (Responses API, tool registry), modes, deterministic commands, contexts, lead capture, barbershop demo, daily cap.
- [ ] T5 — Stage 5: human handoff, admin endpoints (API key), README for WSL, final build/lint/test.

## Acceptance criteria
See original requirements; each stage verified with build, lint, and tests; WhatsApp end-to-end only claimed after real manual test by the user.

## Progress / Evidence
- 2026-10-11: proposal approved; branch feat/bottega-mvp created; T1 started.
- 2026-10-11 T1 done (delegated writer). Evidence: build ok, lint ok, unit 28/28, e2e 2/2, migrate status up to date, /health ok + 503 when db down, boot fails cleanly on missing vars. Versions: Nest 12.1.2, Prisma 7.10.0, zod 4.6.5, TS 6.0.3, Vitest 4.1.11, postgres:18-alpine. Deviations: Vitest (Nest 12 default), ESLint replaces oxlint, partial unique index in separate migration. PENDING: .env.example not written (agent permissions block .env* writes) — user must create it from the prepared content. RDD: not run (local only).

## Next step
T1.

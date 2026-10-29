import { Inject, Injectable, Logger } from '@nestjs/common';
import { loadAgentProfile } from '../agents/agent-profile.js';
import { AiLimitsService } from '../ai/ai-limits.service.js';
import { AiProviderError } from '../ai/ai.provider.js';
import { AiUsageService, usageDay } from '../ai/ai-usage.service.js';
import {
  AI_TRANSCRIBER,
  type AiTranscriber,
  isTranscribable,
} from '../ai/transcriber.js';
import { AppConfigService } from '../config/app-config.service.js';
import {
  AiOutcome,
  type Conversation,
  type Message,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../generated/prisma/client.js';
import { botMayReply } from '../inbox/conversation-state.js';
import { touchConversations } from '../inbox/conversation-activity.js';
import { MEDIA_SOURCE, type MediaSource } from '../media/line-media.service.js';
import { MediaFetchError } from '../media/meta-media.client.js';
import { captionOf, isPdfMime } from '../media/attachment-text.js';
import { oggOpusDurationSeconds } from '../media/ogg-duration.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { JobError } from './job-error.js';
import {
  AUDIO_FAILED_REPLY,
  AUDIO_TOO_LARGE_REPLY,
  audioTooLongReply,
  FILE_TOO_LARGE_REPLY,
  MEDIA_DAILY_CAP_REPLY,
  MEDIA_GONE_REPLY,
  MEDIA_UNAVAILABLE_REPLY,
  MEDIA_UNSUPPORTED_REPLY,
} from './media-replies.js';

/** message.media_error codes (prompt 11). */
export type MediaErrorCode =
  | 'too_long'
  | 'too_large'
  | 'daily_cap'
  | 'ai_cap'
  | 'unsupported_type'
  | 'transcription_failed'
  | 'empty_transcript'
  | 'media_gone'
  /** Meta could not be reached with the line's token (or refused it). */
  | 'media_unavailable'
  /** Not read because the bot did not answer (paused, attended, agent off, echo). */
  | 'skipped';

/** What the reply generator gets about the inbound attachment. */
export type PreparedAttachment =
  | { kind: 'audio'; transcript: string }
  | { kind: 'image'; caption: string | null; dataUrl: string }
  | {
      kind: 'document';
      caption: string | null;
      filename: string;
      dataUrl: string;
    }
  /** Not processed: answer this fixed text, no model call. */
  | { kind: 'rejected'; reply: string }
  /** A prompt 09 cap is reached: the generator's cap handling answers. */
  | { kind: 'capped' };

/** Attachments that count for the daily attachment cap. */
const PROCESSED_KINDS = ['audio', 'image', 'document'] as const;

/**
 * Prepares an inbound attachment before the reply is generated (prompt 11):
 * applies the attachment limits and the prompt 09 caps, fetches the file
 * from Meta and transcribes audio. The transcript or the reason it was not
 * processed (`media_error`) is stored at once and the conversation touched,
 * so the inbox sees it and a retried job never fetches or transcribes again.
 * Images and PDFs are fetched for this turn only (never stored).
 *
 * An audio is transcribed even when the bot will not answer (paused,
 * attended by a person, agent off), so the person can read it; images and
 * PDFs are then left alone.
 */
@Injectable()
export class AttachmentPreparer {
  private readonly logger = new Logger(AttachmentPreparer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly limits: AiLimitsService,
    private readonly usage: AiUsageService,
    @Inject(MEDIA_SOURCE) private readonly media: MediaSource,
    @Inject(AI_TRANSCRIBER) private readonly transcriber: AiTranscriber,
  ) {}

  /** Null for a text message (a location included). */
  async prepare(
    inbound: Message,
    conversation: Conversation,
    isLastAttempt: boolean,
  ): Promise<PreparedAttachment | null> {
    if (inbound.type === MessageType.TEXT) {
      return null;
    }
    const kind = inbound.mediaKind;
    // A row of the previous release, or a type Meta does not describe.
    if (!kind || !inbound.mediaId) {
      return { kind: 'rejected', reply: MEDIA_UNSUPPORTED_REPLY };
    }
    if (inbound.mediaError === 'skipped') {
      return null;
    }
    if (inbound.mediaError) {
      return this.fromError(inbound, inbound.mediaError as MediaErrorCode);
    }
    if (inbound.transcript !== null) {
      return { kind: 'audio', transcript: inbound.transcript };
    }
    if (this.config.get('BOT_REPLY_MODE') !== 'ai') {
      // Echo mode answers its fixed text; nothing was read.
      await this.store(inbound, { mediaError: 'skipped' });
      return null;
    }
    const supported =
      kind === 'image' ||
      (kind === 'document' && isPdfMime(inbound.mediaMime)) ||
      (kind === 'audio' && isTranscribable(inbound.mediaMime ?? ''));
    if (!supported) {
      return this.fail(inbound, 'unsupported_type');
    }

    const profile = await loadAgentProfile(this.prisma, conversation.id);
    const willReply = botMayReply(conversation) && profile.enabled;
    // Only the audio is worth reading without a reply (the inbox shows it).
    // Marked, so it does not count as processed for the daily cap.
    if (!willReply && kind !== 'audio') {
      await this.store(inbound, { mediaError: 'skipped' });
      return null;
    }

    // The attachment's own limits first, then the prompt 09 caps.
    const maxBytes =
      kind === 'audio'
        ? this.config.get('MEDIA_AUDIO_MAX_BYTES')
        : kind === 'image'
          ? this.config.get('MEDIA_IMAGE_MAX_BYTES')
          : this.config.get('MEDIA_DOCUMENT_MAX_BYTES');
    if ((inbound.mediaSize ?? 0) > maxBytes) {
      return this.fail(inbound, 'too_large');
    }
    const caps = await this.limits.forConversation(conversation.id);
    if (!caps) {
      throw new JobError('conversation_missing', false);
    }
    if (
      (await this.processedToday(conversation.id, inbound.id)) >=
      caps.mediaDailyCap
    ) {
      return this.fail(inbound, 'daily_cap');
    }
    if (
      (await this.limits.countMonth(caps.businessId)) >= caps.monthlyCap ||
      (await this.usage.countToday(conversation.id)) >= caps.dailyCap
    ) {
      return this.fail(inbound, 'ai_cap');
    }

    let file: Buffer;
    let mime: string;
    try {
      const info = await this.media.info(conversation.lineId, inbound.mediaId);
      if ((info.fileSize ?? 0) > maxBytes) {
        return this.fail(inbound, 'too_large');
      }
      mime = inbound.mediaMime ?? info.mimeType ?? '';
      file = await this.media.download(conversation.lineId, info.url, maxBytes);
    } catch (error) {
      if (!(error instanceof MediaFetchError)) {
        throw error;
      }
      if (error.code === 'too_large') {
        return this.fail(inbound, 'too_large');
      }
      if (error.retryable && !isLastAttempt) {
        throw new JobError(`media_${error.code}`, true);
      }
      // Gone in Meta: the customer can send it again. Anything else (the
      // line's token, a URL outside Meta, Meta down) is the team's problem.
      const code =
        error.code === 'media_gone' ? 'media_gone' : 'media_unavailable';
      this.logger.warn(
        `Attachment not fetched message=${inbound.id} line=${conversation.lineId} code=${error.code}`,
      );
      return this.fail(inbound, code);
    }

    const dataUrl = () =>
      `data:${mime.split(';')[0]?.trim()};base64,${file.toString('base64')}`;
    if (kind === 'image') {
      return { kind: 'image', caption: captionOf(inbound), dataUrl: dataUrl() };
    }
    if (kind === 'document') {
      return {
        kind: 'document',
        caption: captionOf(inbound),
        filename: inbound.mediaFilename ?? 'documento.pdf',
        dataUrl: dataUrl(),
      };
    }
    const seconds = oggOpusDurationSeconds(file);
    if (seconds !== null && seconds > caps.audioMaxSeconds) {
      return this.fail(inbound, 'too_long', caps.audioMaxSeconds);
    }
    return this.transcribe(
      inbound,
      conversation,
      file,
      mime,
      profile.version,
      isLastAttempt,
    );
  }

  private async transcribe(
    inbound: Message,
    conversation: Conversation,
    audio: Buffer,
    mimeType: string,
    agentProfileVersion: number | null,
    isLastAttempt: boolean,
  ): Promise<PreparedAttachment> {
    const started = Date.now();
    const model = this.config.get('OPENAI_TRANSCRIBE_MODEL');
    const record = (outcome: AiOutcome, served = model) =>
      this.usage.record({
        conversationId: conversation.id,
        model: served,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - started,
        outcome,
        agentProfileVersion,
      });
    let text: string;
    try {
      const result = await this.transcriber.transcribe({ audio, mimeType });
      text = result.text;
      await record(AiOutcome.OK, result.model);
    } catch (error) {
      const failure =
        error instanceof AiProviderError
          ? error
          : new AiProviderError('ai_unexpected', false);
      await record(AiOutcome.ERROR);
      if (failure.retryable && !isLastAttempt) {
        throw new JobError(failure.code, true);
      }
      this.logger.warn(
        `Transcription failed message=${inbound.id} code=${failure.code}`,
      );
      return this.fail(inbound, 'transcription_failed');
    }
    if (!text.trim()) {
      return this.fail(inbound, 'empty_transcript');
    }
    await this.store(inbound, { transcript: text.trim() });
    return { kind: 'audio', transcript: text.trim() };
  }

  /** Attachments of the conversation processed today (Argentina). */
  private async processedToday(
    conversationId: string,
    currentId: string,
  ): Promise<number> {
    const now = new Date();
    const today = usageDay(now).getTime();
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        id: { not: currentId },
        direction: MessageDirection.INBOUND,
        status: MessageStatus.PROCESSED,
        mediaKind: { in: [...PROCESSED_KINDS] },
        mediaError: null,
        // Two days back covers the whole Argentine day; filtered below.
        createdAt: { gte: new Date(now.getTime() - 2 * 24 * 60 * 60_000) },
      },
      select: { createdAt: true, mediaKind: true, mediaMime: true },
    });
    return rows.filter(
      (row) =>
        usageDay(row.createdAt).getTime() === today &&
        (row.mediaKind !== 'document' || isPdfMime(row.mediaMime)),
    ).length;
  }

  /** Stores why it was not processed and returns what to answer. */
  private async fail(
    inbound: Message,
    code: MediaErrorCode,
    audioMaxSeconds?: number,
  ): Promise<PreparedAttachment> {
    await this.store(inbound, { mediaError: code });
    return this.fromError(inbound, code, audioMaxSeconds);
  }

  private async fromError(
    inbound: Message,
    code: MediaErrorCode,
    audioMaxSeconds?: number,
  ): Promise<PreparedAttachment> {
    switch (code) {
      case 'ai_cap':
        return { kind: 'capped' };
      case 'too_long': {
        const max =
          audioMaxSeconds ??
          (await this.limits.forConversation(inbound.conversationId))
            ?.audioMaxSeconds ??
          this.config.get('MEDIA_AUDIO_MAX_SECONDS');
        return { kind: 'rejected', reply: audioTooLongReply(max) };
      }
      case 'too_large':
        return {
          kind: 'rejected',
          reply:
            inbound.mediaKind === 'audio'
              ? AUDIO_TOO_LARGE_REPLY
              : FILE_TOO_LARGE_REPLY,
        };
      case 'daily_cap':
        return { kind: 'rejected', reply: MEDIA_DAILY_CAP_REPLY };
      case 'transcription_failed':
      case 'empty_transcript':
        return { kind: 'rejected', reply: AUDIO_FAILED_REPLY };
      case 'media_gone':
        return { kind: 'rejected', reply: MEDIA_GONE_REPLY };
      case 'media_unavailable':
        return { kind: 'rejected', reply: MEDIA_UNAVAILABLE_REPLY };
      case 'unsupported_type':
      case 'skipped':
        return { kind: 'rejected', reply: MEDIA_UNSUPPORTED_REPLY };
    }
  }

  /** Saves the outcome and touches the conversation (the inbox refetches). */
  private async store(
    inbound: Message,
    data: { transcript: string } | { mediaError: MediaErrorCode },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.message.update({ where: { id: inbound.id }, data });
      await touchConversations(tx, { id: inbound.conversationId });
    });
  }
}

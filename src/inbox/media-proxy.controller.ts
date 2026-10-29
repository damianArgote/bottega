import { Readable } from 'node:stream';
import {
  BadGatewayException,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AppConfigService } from '../config/app-config.service.js';
import { MEDIA_SOURCE, type MediaSource } from '../media/line-media.service.js';
import { verifyMediaSignature } from '../media/media-url.js';
import { MediaFetchError } from '../media/meta-media.client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const idSchema = z.uuid();

/** Types a browser may show in place (anything else is downloaded). */
const INLINE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'video/mp4',
]);

/** The type to serve: inline only for audio and the list above. */
export function servedType(mime: string | null): {
  type: string;
  inline: boolean;
} {
  const base = (mime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (base.startsWith('audio/') || INLINE_TYPES.has(base)) {
    return { type: base, inline: true };
  }
  return { type: 'application/octet-stream', inline: false };
}

/** Headers copied from Meta's response when present. */
const PASSED_HEADERS = ['content-length', 'content-range', 'accept-ranges'];

/**
 * The inbox's attachments, streamed from Meta with the line's token. No
 * session cookie (an <audio> or <img> does not always send it): the signed
 * link (business, message, expiry) is the control. Ranges are passed on
 * (Safari needs them to play audio). Only audio, common images, PDF and MP4
 * are served in place; anything else is a download, so an HTML or SVG file
 * a customer sends never runs on this origin.
 */
@Controller('inbox/businesses/:businessId/media')
export class MediaProxyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(MEDIA_SOURCE) private readonly media: MediaSource,
  ) {}

  @Get(':messageId')
  async stream(
    @Param('businessId') businessId: string,
    @Param('messageId') messageId: string,
    @Query('exp') exp: string | undefined,
    @Query('sig') sig: string | undefined,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (
      !idSchema.safeParse(businessId).success ||
      !idSchema.safeParse(messageId).success ||
      !verifyMediaSignature(
        this.config.get('MEDIA_URL_SECRET'),
        businessId,
        messageId,
        typeof exp === 'string' ? exp : undefined,
        typeof sig === 'string' ? sig : undefined,
      )
    ) {
      throw new ForbiddenException('Invalid or expired link');
    }
    const message = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        mediaId: { not: null },
        conversation: { line: { businessId } },
      },
      select: {
        mediaId: true,
        mediaMime: true,
        conversation: { select: { lineId: true } },
      },
    });
    if (!message?.mediaId) {
      throw new NotFoundException('Attachment not found');
    }

    let meta: globalThis.Response;
    try {
      const lineId = message.conversation.lineId;
      const info = await this.media.info(lineId, message.mediaId);
      meta = await this.media.open(
        lineId,
        info.url,
        typeof range === 'string' ? range : undefined,
      );
    } catch (error) {
      if (error instanceof MediaFetchError && error.code === 'media_gone') {
        throw new GoneException('El archivo ya no está disponible en WhatsApp');
      }
      throw new BadGatewayException('Could not fetch the attachment');
    }

    const { type, inline } = servedType(
      message.mediaMime ?? meta.headers.get('content-type'),
    );
    res.status(meta.status === 206 ? 206 : 200);
    res.setHeader('Content-Type', type);
    if (!inline) {
      res.setHeader('Content-Disposition', 'attachment');
    }
    for (const name of PASSED_HEADERS) {
      const value = meta.headers.get(name);
      if (value) {
        res.setHeader(name, value);
      }
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('Cache-Control', 'private, no-store');
    if (!meta.body) {
      res.end();
      return;
    }
    Readable.fromWeb(meta.body as Parameters<typeof Readable.fromWeb>[0])
      .on('error', () => res.destroy())
      .pipe(res);
  }
}

import { Injectable } from '@nestjs/common';
import { CredentialsDecryptError } from '../lines/credentials-cipher.js';
import { LineCredentialsService } from '../lines/line-credentials.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  MediaFetchError,
  type MediaInfo,
  MetaMediaClient,
} from './meta-media.client.js';

/** A line's attachments in Meta (the bot and the inbox proxy use it). */
export interface MediaSource {
  info(lineId: string, mediaId: string): Promise<MediaInfo>;
  /** The file's response for streaming (200, or 206 for a range). */
  open(lineId: string, url: string, range?: string): Promise<Response>;
  download(lineId: string, url: string, maxBytes: number): Promise<Buffer>;
}

export const MEDIA_SOURCE = Symbol('MEDIA_SOURCE');

/**
 * {@link MediaSource} with each line's own System User token, decrypted per
 * call. A line without a usable token cannot fetch anything (not retried).
 */
@Injectable()
export class LineMediaSource implements MediaSource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: LineCredentialsService,
    private readonly client: MetaMediaClient,
  ) {}

  async info(lineId: string, mediaId: string): Promise<MediaInfo> {
    return this.client.info(await this.token(lineId), mediaId);
  }

  async open(lineId: string, url: string, range?: string): Promise<Response> {
    return this.client.open(await this.token(lineId), url, range);
  }

  async download(
    lineId: string,
    url: string,
    maxBytes: number,
  ): Promise<Buffer> {
    return this.client.download(await this.token(lineId), url, maxBytes);
  }

  private async token(lineId: string): Promise<string> {
    const line = await this.prisma.line.findUnique({
      where: { id: lineId },
      select: { accessTokenEncrypted: true },
    });
    if (!line?.accessTokenEncrypted) {
      throw new MediaFetchError('media_unavailable', false);
    }
    try {
      return this.credentials.decrypt(line.accessTokenEncrypted);
    } catch (error) {
      if (error instanceof CredentialsDecryptError) {
        throw new MediaFetchError('media_unavailable', false);
      }
      throw error;
    }
  }
}

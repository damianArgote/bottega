import { fileURLToPath } from 'node:url';
import { Injectable, Logger } from '@nestjs/common';
import type { DemoScenario } from '../demos/demo-scenarios.js';
import {
  type Content,
  type DemoContent,
  loadContent,
} from './content.schema.js';

/**
 * `<project root>/content`. This file lives at `src/content/` when run from
 * source and at `dist/content/` when built, two levels below the root in both.
 */
export const DEFAULT_CONTENT_DIR = fileURLToPath(
  new URL('../../content/', import.meta.url),
);

/**
 * Editable bot knowledge (see content/README.md), loaded and validated once
 * when the service is created: an invalid file aborts the boot.
 */
@Injectable()
export class ContentService {
  private readonly content: Content;

  constructor() {
    this.content = loadContent(DEFAULT_CONTENT_DIR);
    new Logger(ContentService.name).log('Content files loaded and valid');
  }

  /** Commercial knowledge in Markdown (editing comments stripped). */
  getCommercialInfo(): string {
    return this.content.commercialInfo;
  }

  /** Fictitious business of a demo scenario. */
  getDemo(scenario: DemoScenario): DemoContent {
    return this.content[scenario];
  }
}

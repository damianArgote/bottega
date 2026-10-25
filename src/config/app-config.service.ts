import { Injectable } from '@nestjs/common';
import { type Env, parseEnv } from './env.schema.js';

/**
 * Typed, read-only accessor for the validated environment.
 *
 * It serves its own validated copy instead of delegating to Nest's
 * ConfigService, which falls back to the raw `process.env` value when a
 * validated value is undefined: a blank optional secret would come back as
 * the raw spaces instead of "not set". ConfigModule (in AppConfigModule)
 * still loads `.env` into `process.env` and aborts the boot when it is
 * invalid.
 */
@Injectable()
export class AppConfigService {
  private readonly env: Readonly<Env> = Object.freeze(parseEnv(process.env));

  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key];
  }
}

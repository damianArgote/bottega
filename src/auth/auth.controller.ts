import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { parseOrBadRequest } from '../admin/admin.schemas.js';
import {
  clearAuthCookies,
  readCookie,
  REFRESH_COOKIE,
  setAuthCookies,
} from './auth-cookies.js';
import { AuthService, type SessionUser } from './auth.service.js';
import { CurrentUser, SessionGuard } from './session.guard.js';

const loginBodySchema = z
  .object({
    email: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(200),
  })
  .strict();

/** Inbox sessions, kept in httpOnly cookies. */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { email, password } = parseOrBadRequest(
      loginBodySchema,
      body ?? {},
      'body',
    );
    const issued = await this.auth.login(email, password, req.ip ?? 'unknown');
    setAuthCookies(res, issued);
    return { user: issued.user };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const issued = await this.auth.refresh(
      readCookie(req.cookies, REFRESH_COOKIE),
    );
    setAuthCookies(res, issued);
    return { user: issued.user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(readCookie(req.cookies, REFRESH_COOKIE));
    clearAuthCookies(res);
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: SessionUser) {
    return this.auth.me(user);
  }
}

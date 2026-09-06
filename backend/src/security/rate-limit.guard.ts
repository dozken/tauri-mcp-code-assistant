import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { API_ROUTES } from '@ai-code-companion/contracts';
import { APP_CONFIG, type AppConfig } from '../config/configuration.js';
import { CALLER } from './local-access.guard.js';
import { ANONYMOUS_CALLER } from './local-access.js';
import { FixedWindowLimiter, type RateLimitPolicy } from './rate-limit.js';

/**
 * Only the two routes that cost something real. `/status` is polled by the UI and
 * `/health` by anything supervising the process; limiting either would break a
 * caller that is behaving correctly, to protect against nothing.
 *
 * The Socket.IO path is deliberately absent: the gateway already runs one turn
 * per socket and aborts the previous one, so a loop there cannot stack work the
 * way a loop of HTTP posts can.
 */
const LIMITED = new Set<string>([API_ROUTES.chat, API_ROUTES.index]);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiter = new FixedWindowLimiter();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.rateLimit.enabled || context.getType() !== 'http') return true;

    const request = context
      .switchToHttp()
      .getRequest<{ path?: string; method?: string } & Record<symbol, unknown>>();
    // Stryker disable next-line StringLiteral: Express always sets `path`; the
    // fallback exists because the type says it might not.
    const path = request.path ?? '';
    // A GET is a read; the cost this guards is in starting work, not in asking
    // about it, and `DELETE /index` shares a path with the expensive `POST`.
    if (request.method !== 'POST' || !LIMITED.has(path)) return true;

    // Per caller, not one bucket for the machine: a script in a loop should blow
    // its own fuse and leave the desktop window working. The access guard has
    // already worked out who this is.
    const caller = typeof request[CALLER] === 'string' ? request[CALLER] : ANONYMOUS_CALLER;
    const decision = this.limiter.consume(`${caller}|${path}`, this.policyFor(path));
    if (decision.allowed) return true;

    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message:
          `Too many requests to ${path}. This is a local fuse against a runaway ` +
          `script, not a quota — raise RATE_LIMIT_${path === API_ROUTES.chat ? 'CHAT' : 'INDEX'} if it is in the way.`,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private policyFor(path: string): RateLimitPolicy {
    const { windowMs, chatPerWindow, indexPerWindow } = this.config.rateLimit;
    return { windowMs, limit: path === API_ROUTES.chat ? chatPerWindow : indexPerWindow };
  }
}

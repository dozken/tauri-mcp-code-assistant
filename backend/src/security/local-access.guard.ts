import type { IncomingHttpHeaders } from 'node:http';
import {
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WsException } from '@nestjs/websockets';
import { APP_CONFIG, type AppConfig } from '../config/configuration.js';
import { callerOf, decideAccess, type AccessRequest } from './local-access.js';

/**
 * Where the guard leaves the caller it identified, for the rate limiter to key on.
 * A property on the request rather than a second pass over the headers: two places
 * parsing the same headers is two places to disagree about who is calling.
 */
export const CALLER = Symbol('local-access:caller');

const PUBLIC = 'local-access:public';

/** Opts a route out of the guard. Only `/health` should use it. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC, true);

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const credentialsOf = (headers: IncomingHttpHeaders): AccessRequest => ({
  origin: first(headers.origin),
  host: first(headers.host),
  authorization: first(headers.authorization),
  clientId: first(headers['x-client-id']),
});

/**
 * Both shapes carry the handshake headers: an `IncomingMessage` for HTTP, and a
 * Socket.IO socket, whose `handshake` is the parsed form of its own `request`.
 */
interface HeaderCarrier {
  readonly headers?: IncomingHttpHeaders;
  readonly handshake?: { readonly headers: IncomingHttpHeaders };
  readonly request?: { readonly headers: IncomingHttpHeaders };
}

const headersOf = (carrier: HeaderCarrier): IncomingHttpHeaders =>
  carrier.handshake?.headers ?? carrier.request?.headers ?? carrier.headers ?? {};

/**
 * Applies {@link decideAccess} to every HTTP request and Socket.IO message.
 *
 * Registered globally rather than per-controller: a new endpoint should be
 * protected because it exists, not because someone remembered a decorator.
 */
@Injectable()
export class LocalAccessGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const isWs = context.getType() === 'ws';
    const carrier: HeaderCarrier = isWs
      ? context.switchToWs().getClient<HeaderCarrier>()
      : context.switchToHttp().getRequest<HeaderCarrier>();

    const credentials = credentialsOf(headersOf(carrier));
    const decision = decideAccess(credentials, this.config);
    if (decision.allowed) {
      (carrier as Record<symbol, unknown>)[CALLER] = callerOf(credentials, decision);
      return true;
    }

    // A WsException reaches the client as an `exception` event; an HTTP
    // exception here would be swallowed by the socket transport.
    throw isWs ? new WsException(decision.reason) : new UnauthorizedException(decision.reason);
  }
}

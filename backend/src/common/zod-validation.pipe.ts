import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates a request against a schema from `@ai-code-companion/contracts`.
 *
 * Replaces `class-validator` DTOs deliberately: the same schema object then backs
 * the HTTP body, the Socket.IO payload, the MCP tool input and the React client,
 * so a contract change is a compile error everywhere instead of four hand-written
 * definitions drifting apart.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new BadRequestException({
      message: result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
      error: 'Bad Request',
      statusCode: 400,
    });
  }
}

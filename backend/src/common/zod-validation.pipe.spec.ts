import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const schema = z.object({
  path: z.string().trim().min(1),
  limit: z.number().int().optional(),
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('returns the parsed value, with transforms applied', () => {
    expect(pipe.transform({ path: '  /repo  ' })).toEqual({ path: '/repo' });
  });

  it('strips unknown keys rather than passing them to a service', () => {
    expect(pipe.transform({ path: '/repo', rogue: true })).toEqual({ path: '/repo' });
  });

  it('throws a 400 naming the field that failed', () => {
    expect(() => pipe.transform({ path: '' })).toThrow(BadRequestException);

    try {
      pipe.transform({ path: '' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const response = (error as BadRequestException).getResponse();
      expect(response).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(JSON.stringify(response)).toContain('path');
    }
  });

  it('labels a failure at the root of the payload', () => {
    const rootPipe = new ZodValidationPipe(z.string());

    try {
      rootPipe.transform(42);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(JSON.stringify((error as BadRequestException).getResponse())).toContain('(root)');
    }
  });

  it.each([undefined, null, 'string', 42, []])('rejects %s for an object schema', (value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });

  it('reports every failing field, not just the first', () => {
    try {
      pipe.transform({ path: '', limit: 1.5 });
      expect.unreachable('should have thrown');
    } catch (error) {
      const body = JSON.stringify((error as BadRequestException).getResponse());
      expect(body).toContain('path');
      expect(body).toContain('limit');
    }
  });
});

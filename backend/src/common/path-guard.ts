import { stat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

export const isWithinRoots = (candidate: string, allowedRoots: readonly string[]): boolean =>
  allowedRoots.some((root) => candidate === root || candidate.startsWith(root + sep));

/**
 * Resolves a user-supplied path and proves it stays inside the allow-list.
 *
 * `realpath` runs *before* the containment check on purpose: a symlink inside an
 * allowed folder must not be able to point at `/etc/shadow` and still pass.
 */
export const resolveWithinRoots = async (
  inputPath: string,
  allowedRoots: readonly string[],
  expect: 'file' | 'directory',
): Promise<string> => {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new BadRequestException('path is required');
  }

  let realPath: string;
  try {
    realPath = await realpath(resolve(inputPath.trim()));
  } catch {
    throw new NotFoundException(`Path does not exist: ${inputPath}`);
  }

  if (!isWithinRoots(realPath, allowedRoots)) {
    throw new ForbiddenException(
      `Path is outside the allowed roots (${allowedRoots.join(', ')}). ` +
        'Set INDEX_ALLOWED_ROOTS to widen it.',
    );
  }

  const stats = await stat(realPath);
  if (expect === 'directory' && !stats.isDirectory()) {
    throw new BadRequestException(`Not a directory: ${inputPath}`);
  }
  if (expect === 'file' && !stats.isFile()) {
    throw new BadRequestException(`Not a file: ${inputPath}`);
  }

  return realPath;
};

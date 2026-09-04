import 'reflect-metadata';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { ConfiguredIoAdapter } from './common/io-adapter.js';
import { APP_CONFIG, loadConfig, type AppConfig } from './config/configuration.js';

/**
 * Writes the token where local tooling can find it, owner-readable only.
 *
 * The MCP server, a script or a packaged shell has no `Origin` to prove itself
 * with, so it needs the token — and asking a user to copy one out of a log is how
 * you end up with `AUTH_ENABLED=false` in someone's shell profile.
 */
const publishToken = async (config: AppConfig): Promise<void> => {
  await mkdir(dirname(config.auth.tokenFile), { recursive: true, mode: 0o700 });
  await writeFile(config.auth.tokenFile, config.auth.token, { encoding: 'utf8', mode: 0o600 });
  // Explicit chmod: `mode` on writeFile is ignored when the file already exists.
  await chmod(config.auth.tokenFile, 0o600);
};

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get<AppConfig>(APP_CONFIG);

  app.useLogger(app.get(Logger));
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, config));
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.enableShutdownHooks();

  const logger = app.get(Logger);

  if (config.auth.enabled) {
    try {
      await publishToken(config);
      logger.log(`Access token written to ${config.auth.tokenFile}`);
    } catch (error) {
      logger.warn(
        `Could not write ${config.auth.tokenFile}: ${error instanceof Error ? error.message : String(error)}. ` +
          'Non-browser clients will need COMPANION_TOKEN.',
      );
    }
  } else {
    logger.warn('AUTH_ENABLED=false: any local process can reach this API.');
  }

  // Loopback by default: this is a desktop companion, not a shared service, and the
  // /index endpoint reads local files.
  await app.listen(config.port, config.host);

  logger.log(
    `AI Code Companion backend on http://${config.host}:${config.port} ` +
      `(llm=${config.llm.provider}, embeddings=${config.embeddings.provider}, ` +
      `auth=${config.auth.enabled ? 'on' : 'off'})`,
  );
};

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet, so this one goes straight to the console.
  const { port, host } = loadConfig();
  console.error(`Failed to start backend on ${host}:${port}`, error);
  process.exit(1);
});

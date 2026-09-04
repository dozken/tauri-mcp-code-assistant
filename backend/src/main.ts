import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { INestApplication } from '@nestjs/common';
import type { ServerOptions } from 'socket.io';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { APP_CONFIG, loadConfig, type AppConfig } from './config/configuration.js';

/** Applies the configured CORS origins to Socket.IO as well as to HTTP. */
class ConfiguredIoAdapter extends IoAdapter {
  constructor(
    app: INestApplication,
    private readonly origins: string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.origins, credentials: true },
    });
  }
}

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get<AppConfig>(APP_CONFIG);

  app.useLogger(app.get(Logger));
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, config.corsOrigins));
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();

  // Loopback by default: this is a desktop companion, not a shared service, and the
  // /index endpoint reads local files.
  await app.listen(config.port, config.host);

  app
    .get(Logger)
    .log(
      `AI Code Companion backend on http://${config.host}:${config.port} ` +
        `(llm=${config.llm.provider}, embeddings=${config.embeddings.provider})`,
    );
};

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet, so this one goes straight to the console.
  const { port, host } = loadConfig();
  console.error(`Failed to start backend on ${host}:${port}`, error);
  process.exit(1);
});

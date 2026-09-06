import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

interface OllamaToolCall {
  readonly function: { readonly name: string; readonly arguments: Record<string, unknown> };
}

export interface OllamaReply {
  /** Streamed one chunk at a time, the way `/api/chat` answers. */
  readonly tokens?: readonly string[];
  readonly toolCalls?: readonly OllamaToolCall[];
  /** What `/api/embed` returns, one vector per input. */
  readonly embeddings?: readonly (readonly number[])[];
}

export interface FakeOllama {
  readonly url: string;
  /** The last request, so a test can assert what actually went on the wire. */
  readonly seen: { path?: string; body?: Record<string, unknown> };
  readonly close: () => Promise<void>;
}

/**
 * A server speaking Ollama's protocol, for testing the providers against the real
 * client rather than a mock of it.
 *
 * The thing worth checking is not that we call a constructor — it is that the
 * options we hand it come out on the wire as Ollama expects, and that what Ollama
 * sends back arrives as the shapes the app consumes. A provider nobody has ever
 * run is a guess, and this repository has paid for one of those already.
 */
export const startFakeOllama = async (reply: OllamaReply = {}): Promise<FakeOllama> => {
  const seen: { path?: string; body?: Record<string, unknown> } = {};

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.path = request.url;
      seen.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;

      if (request.url === '/api/embed') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ model: 'fake', embeddings: reply.embeddings ?? [] }));
        return;
      }

      // `/api/chat` streams newline-delimited JSON, one object per token.
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const content of reply.tokens ?? []) {
        response.write(
          `${JSON.stringify({ message: { role: 'assistant', content }, done: false })}\n`,
        );
      }
      response.end(
        `${JSON.stringify({
          message: { role: 'assistant', content: '', tool_calls: reply.toolCalls },
          done: true,
          done_reason: 'stop',
        })}\n`,
      );
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    seen,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
};

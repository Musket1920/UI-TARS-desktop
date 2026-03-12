import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';

export type LocalhostOpenAICompatibleFixtureState =
  | 'chat-success'
  | 'models-timeout'
  | 'responses-supported'
  | 'responses-generic-error'
  | 'responses-timeout'
  | 'responses-unsupported'
  | 'unreachable-host'
  | 'invalid-model'
  | 'malformed-payload';

export interface LocalhostOpenAICompatibleFixtureRequest {
  method: string;
  path: string;
  body: unknown;
  aborted: boolean;
}

export interface LocalhostOpenAICompatibleFixtureInput {
  baseUrl: string;
  apiKey: string; // secretlint-disable-line @secretlint/secretlint-rule-pattern -- fixture contract field name only
  modelName: string;
}

export interface LocalhostOpenAICompatibleFixture {
  state: LocalhostOpenAICompatibleFixtureState;
  input: LocalhostOpenAICompatibleFixtureInput;
  requests: LocalhostOpenAICompatibleFixtureRequest[];
  close: () => Promise<void>;
}

interface LocalhostOpenAICompatibleFixtureOptions {
  apiKey?: string;
  modelName?: string;
}

const DEFAULT_API_KEY = 'fixture-api-key';
const DEFAULT_MODEL_NAME = 'fixture-model';
const LOCALHOST_HOST = '127.0.0.1';

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return null;
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void => {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
};

const writeMalformedJson = (response: ServerResponse): void => {
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json');
  response.end('{"fixture":"malformed"');
};

const writeModelNotFound = (
  response: ServerResponse,
  modelName: string,
): void => {
  writeJson(response, 404, {
    error: {
      message: `The model \`${modelName}\` does not exist`,
      type: 'invalid_request_error',
      code: 'model_not_found',
    },
  });
};

const writeResponsesUnsupported = (
  response: ServerResponse,
  message: string,
  statusCode = 404,
): void => {
  writeJson(response, statusCode, {
    error: {
      message,
      type: 'invalid_request_error',
    },
  });
};

const closeNetServer = async (
  server: ReturnType<typeof createNetServer>,
  sockets: Set<Socket>,
): Promise<void> => {
  for (const socket of sockets) {
    socket.destroy();
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
};

const writeChatSuccess = (
  response: ServerResponse,
  modelName: string,
): void => {
  writeJson(response, 200, {
    id: 'chatcmpl_fixture',
    object: 'chat.completion',
    created: 0,
    model: modelName,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '2',
        },
      },
    ],
  });
};

const writeModelsSuccess = (
  response: ServerResponse,
  modelNames: string[],
): void => {
  writeJson(response, 200, {
    object: 'list',
    data: modelNames.map((modelName) => ({
      id: modelName,
      object: 'model',
      created: 0,
      owned_by: 'fixture',
    })),
  });
};

const writeResponsesSuccess = (
  response: ServerResponse,
  modelName: string,
): void => {
  writeJson(response, 200, {
    id: 'resp_fixture',
    object: 'response',
    created_at: 0,
    model: modelName,
    status: 'completed',
    output: [],
  });
};

const createLocalhostOpenAICompatibleServer = (
  state: LocalhostOpenAICompatibleFixtureState,
  modelName: string,
  requests: LocalhostOpenAICompatibleFixtureRequest[],
) => {
  return createServer(async (request, response) => {
    try {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', `http://${LOCALHOST_HOST}`);
      const path = url.pathname;
      const body = method === 'POST' ? await readJsonBody(request) : null;
      const requestRecord = {
        method,
        path,
        body,
        aborted: false,
      };

      requests.push(requestRecord);
      request.on('aborted', () => {
        requestRecord.aborted = true;
      });
      response.on('close', () => {
        if (!response.writableEnded) {
          requestRecord.aborted = true;
        }
      });

      if (path === '/v1/models') {
        if (state === 'models-timeout') {
          return;
        }

        if (state === 'malformed-payload') {
          writeMalformedJson(response);
          return;
        }

        writeModelsSuccess(
          response,
          state === 'invalid-model' ? [`${modelName}-available`] : [modelName],
        );
        return;
      }

      if (path === '/v1/chat/completions') {
        if (state === 'invalid-model') {
          writeModelNotFound(response, modelName);
          return;
        }

        if (state === 'malformed-payload') {
          writeMalformedJson(response);
          return;
        }

        writeChatSuccess(response, modelName);
        return;
      }

      if (path === '/v1/responses') {
        if (state === 'responses-supported') {
          writeResponsesSuccess(response, modelName);
          return;
        }

        if (state === 'responses-generic-error') {
          writeResponsesUnsupported(
            response,
            'Generic backend error: responses remain unsupported for this deployment',
            500,
          );
          return;
        }

        if (state === 'responses-timeout') {
          return;
        }

        if (state === 'malformed-payload') {
          writeMalformedJson(response);
          return;
        }

        if (state === 'invalid-model') {
          writeModelNotFound(response, modelName);
          return;
        }

        if (state === 'chat-success') {
          writeResponsesUnsupported(
            response,
            '501 Not Implemented for POST /responses in chat-success mode',
            501,
          );
          return;
        }

        writeResponsesUnsupported(response, '404 Not Found for POST /responses');
        return;
      }

      writeJson(response, 404, {
        error: {
          message: `No fixture route for ${method} ${path}`,
        },
      });
    } catch (error) {
      writeJson(response, 500, {
        error: {
          message: error instanceof Error ? error.message : 'Fixture failed',
        },
      });
    }
  });
};

export const createLocalhostOpenAICompatibleFixture = async (
  state: LocalhostOpenAICompatibleFixtureState,
  options: LocalhostOpenAICompatibleFixtureOptions = {},
): Promise<LocalhostOpenAICompatibleFixture> => {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY; // secretlint-disable-line @secretlint/secretlint-rule-pattern -- fixture-only placeholder value
  const modelName = options.modelName ?? DEFAULT_MODEL_NAME;
  const requests: LocalhostOpenAICompatibleFixtureRequest[] = [];

  if (state === 'unreachable-host') {
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LOCALHOST_HOST, () => {
        resolve();
      });
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      await closeNetServer(server, sockets);
      throw new Error('Could not determine localhost fixture address');
    }

    let closed = false;

    return {
      state,
      input: {
        baseUrl: `http://${LOCALHOST_HOST}:${address.port}/v1`,
        apiKey,
        modelName,
      },
      requests,
      close: async () => {
        if (closed) {
          return;
        }

        closed = true;
        await closeNetServer(server, sockets);
      },
    };
  }

  const server = createLocalhostOpenAICompatibleServer(state, modelName, requests);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOCALHOST_HOST, () => {
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not determine localhost fixture address');
  }

  let closed = false;

  return {
    state,
    input: {
      baseUrl: `http://${LOCALHOST_HOST}:${address.port}/v1`,
      apiKey,
      modelName,
    },
    requests,
    close: async () => {
      if (closed) {
        return;
      }

      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
};

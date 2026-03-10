import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

type ParseSidecarArgs = (rawArgs: string | undefined) => string[];
type StartAgentSSidecarInBackground = (
  startSidecar?: () => Promise<void>,
  logError?: (message: string, error: unknown) => void,
) => void;
type StartAgentSSidecarIfNeeded = (settings?: {
  engineMode: string;
  agentSSidecarMode: string;
  agentSSidecarUrl?: string;
  agentSSidecarPort?: number;
}) => Promise<void>;

const extractConstArrowFunction = <T>(
  name: string,
  scope: Record<string, unknown> = {},
): T => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const signature = `const ${name} =`;
  const start = source.indexOf(signature);

  if (start === -1) {
    throw new Error(`Could not find ${name} in main.ts`);
  }

  const bodyStart = source.indexOf('{', start);

  if (bodyStart === -1) {
    throw new Error(`Could not find ${name} body start`);
  }

  let depth = 0;
  let bodyEnd = -1;

  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;

      if (depth === 0) {
        bodyEnd = index;
        break;
      }
    }
  }

  if (bodyEnd === -1) {
    throw new Error(`Could not find ${name} body end`);
  }

  const statementEnd = source.indexOf(';', bodyEnd);

  if (statementEnd === -1) {
    throw new Error(`Could not find ${name} statement end`);
  }

  const snippet = `${source.slice(start, statementEnd + 1)}\nmodule.exports = { ${name} };`;
  const transpiled = transpileModule(snippet, {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} as Record<string, T> };
  const scopeNames = Object.keys(scope);
  const scopeValues = Object.values(scope);

  new Function(...scopeNames, 'module', 'exports', transpiled)(
    ...scopeValues,
    module,
    module.exports,
  );

  return module.exports[name];
};

const extractParseSidecarArgs = (logger: {
  warn: (message: string, details?: unknown) => void;
}): ParseSidecarArgs => {
  return extractConstArrowFunction<ParseSidecarArgs>('parseSidecarArgs', {
    logger,
  });
};

const extractStartAgentSSidecarInBackground =
  (): StartAgentSSidecarInBackground => {
    return extractConstArrowFunction<StartAgentSSidecarInBackground>(
      'startAgentSSidecarInBackground',
    );
  };

const extractStartAgentSSidecarIfNeeded = (
  scope: Record<string, unknown>,
): StartAgentSSidecarIfNeeded => {
  return extractConstArrowFunction<StartAgentSSidecarIfNeeded>(
    'startAgentSSidecarIfNeeded',
    scope,
  );
};

describe('parseSidecarArgs', () => {
  it('keeps quoted values with spaces as a single token', () => {
    const logger = { warn: vi.fn() };
    const parseSidecarArgs = extractParseSidecarArgs(logger);

    expect(
      parseSidecarArgs('--flag "value with spaces" --other "two words"'),
    ).toEqual(['--flag', 'value with spaces', '--other', 'two words']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('preserves leading and trailing whitespace inside quoted args', () => {
    const logger = { warn: vi.fn() };
    const parseSidecarArgs = extractParseSidecarArgs(logger);

    expect(parseSidecarArgs("--model-id '  model v2  '")).toEqual([
      '--model-id',
      '  model v2  ',
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps simple unquoted arg strings unchanged', () => {
    const logger = { warn: vi.fn() };
    const parseSidecarArgs = extractParseSidecarArgs(logger);

    expect(parseSidecarArgs('alpha beta  gamma')).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('preserves empty input handling and active-quote escapes', () => {
    const logger = { warn: vi.fn() };
    const parseSidecarArgs = extractParseSidecarArgs(logger);

    expect(parseSidecarArgs('   ')).toEqual([]);
    expect(parseSidecarArgs('--message "say \\\"hi\\\""')).toEqual([
      '--message',
      'say "hi"',
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns when a quoted arg is unterminated while preserving parsed tokens', () => {
    const logger = { warn: vi.fn() };
    const parseSidecarArgs = extractParseSidecarArgs(logger);

    expect(parseSidecarArgs('--flag "value with spaces')).toEqual([
      '--flag',
      'value with spaces',
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      '[agentS sidecar] AGENT_S_SIDECAR_ARGS ended with an unterminated double quote; arguments may be incorrect',
    );
  });
});

describe('startAgentSSidecarInBackground', () => {
  const startAgentSSidecarInBackground =
    extractStartAgentSSidecarInBackground();

  it('starts sidecar work without waiting for readiness', async () => {
    let resolveStartup!: () => void;
    let settled = false;
    const startupPromise = new Promise<void>((resolve) => {
      resolveStartup = resolve;
    }).finally(() => {
      settled = true;
    });
    const startSidecar = vi.fn(() => startupPromise);
    const logError = vi.fn();

    startAgentSSidecarInBackground(startSidecar, logError);

    expect(startSidecar).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(logError).not.toHaveBeenCalled();

    resolveStartup();
    await startupPromise;
    expect(settled).toBe(true);
  });

  it('logs startup errors from the background task', async () => {
    const error = new Error('sidecar failed');
    const startSidecar = vi.fn(async () => {
      throw error;
    });
    const logError = vi.fn();

    startAgentSSidecarInBackground(startSidecar, logError);
    await Promise.resolve();

    expect(logError).toHaveBeenCalledWith(
      '[agentS sidecar] failed to start during app initialization',
      error,
    );
  });
});

describe('startAgentSSidecarIfNeeded', () => {
  it('strips AGENT_S_ENABLE_LOCAL_ENV from embedded sidecar env', async () => {
    const start = vi.fn(async () => ({
      state: 'running',
      healthy: true,
      reason: undefined,
      endpoint: 'http://127.0.0.1:3000',
      pid: 123,
    }));
    const parseSidecarArgs = vi.fn(() => ['--serve']);
    const resolveSidecarEndpoint = vi.fn(() => 'http://127.0.0.1:3000');
    const logger = { info: vi.fn() };
    const startAgentSSidecarIfNeeded = extractStartAgentSSidecarIfNeeded({
      SettingStore: { getStore: vi.fn() },
      agentSSidecarManager: {
        start,
        stop: vi.fn(),
      },
      DEFAULT_STARTUP_TIMEOUT_MS: 1,
      DEFAULT_STARTUP_POLL_INTERVAL_MS: 2,
      DEFAULT_HEARTBEAT_INTERVAL_MS: 3,
      DEFAULT_HEALTH_TIMEOUT_MS: 4,
      DEFAULT_SHUTDOWN_TIMEOUT_MS: 5,
      resolveSidecarEndpoint,
      EngineMode: { AgentS: 'agent-s' },
      AgentSSidecarMode: { Remote: 'remote' },
      parseSidecarArgs,
      logger,
      process,
    });
    const previousLocalEnv = process.env.AGENT_S_ENABLE_LOCAL_ENV;
    const previousPreservedEnv = process.env.SIDECAR_PRESERVED_ENV;
    const previousArgs = process.env.AGENT_S_SIDECAR_ARGS;
    const previousCommand = process.env.AGENT_S_SIDECAR_COMMAND;

    process.env.AGENT_S_ENABLE_LOCAL_ENV = '1';
    process.env.SIDECAR_PRESERVED_ENV = 'allowed';
    process.env.AGENT_S_SIDECAR_ARGS = '--serve';
    process.env.AGENT_S_SIDECAR_COMMAND = 'agent_s_custom';

    try {
      await startAgentSSidecarIfNeeded({
        engineMode: 'agent-s',
        agentSSidecarMode: 'embedded',
        agentSSidecarUrl: 'http://127.0.0.1',
        agentSSidecarPort: 3000,
      });
    } finally {
      if (previousLocalEnv === undefined) {
        delete process.env.AGENT_S_ENABLE_LOCAL_ENV;
      } else {
        process.env.AGENT_S_ENABLE_LOCAL_ENV = previousLocalEnv;
      }

      if (previousPreservedEnv === undefined) {
        delete process.env.SIDECAR_PRESERVED_ENV;
      } else {
        process.env.SIDECAR_PRESERVED_ENV = previousPreservedEnv;
      }

      if (previousArgs === undefined) {
        delete process.env.AGENT_S_SIDECAR_ARGS;
      } else {
        process.env.AGENT_S_SIDECAR_ARGS = previousArgs;
      }

      if (previousCommand === undefined) {
        delete process.env.AGENT_S_SIDECAR_COMMAND;
      } else {
        process.env.AGENT_S_SIDECAR_COMMAND = previousCommand;
      }
    }

    expect(parseSidecarArgs).toHaveBeenCalledWith('--serve');
    expect(resolveSidecarEndpoint).toHaveBeenCalledWith(
      'http://127.0.0.1',
      3000,
    );
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'embedded',
        command: 'agent_s_custom',
        args: ['--serve'],
        env: expect.objectContaining({
          SIDECAR_PRESERVED_ENV: 'allowed',
        }),
      }),
    );
    const firstStartCall = start.mock.calls[0] as
      | [{ env?: NodeJS.ProcessEnv }?]
      | undefined;

    expect(firstStartCall?.[0]?.env).not.toHaveProperty(
      'AGENT_S_ENABLE_LOCAL_ENV',
    );
  });
});

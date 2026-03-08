import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

type ParseSidecarArgs = (rawArgs: string | undefined) => string[];
type StartAgentSSidecarInBackground = (
  startSidecar?: () => Promise<void>,
  logError?: (message: string, error: unknown) => void,
) => void;

const extractConstArrowFunction = <T>(name: string): T => {
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

  new Function('module', 'exports', transpiled)(module, module.exports);

  return module.exports[name];
};

const extractParseSidecarArgs = (): ParseSidecarArgs => {
  return extractConstArrowFunction<ParseSidecarArgs>('parseSidecarArgs');
};

const extractStartAgentSSidecarInBackground =
  (): StartAgentSSidecarInBackground => {
    return extractConstArrowFunction<StartAgentSSidecarInBackground>(
      'startAgentSSidecarInBackground',
    );
  };

describe('parseSidecarArgs', () => {
  const parseSidecarArgs = extractParseSidecarArgs();

  it('keeps quoted values with spaces as a single token', () => {
    expect(
      parseSidecarArgs('--flag "value with spaces" --other "two words"'),
    ).toEqual(['--flag', 'value with spaces', '--other', 'two words']);
  });

  it('preserves leading and trailing whitespace inside quoted args', () => {
    expect(parseSidecarArgs("--model-id '  model v2  '")).toEqual([
      '--model-id',
      '  model v2  ',
    ]);
  });

  it('keeps simple unquoted arg strings unchanged', () => {
    expect(parseSidecarArgs('alpha beta  gamma')).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('preserves empty input handling and active-quote escapes', () => {
    expect(parseSidecarArgs('   ')).toEqual([]);
    expect(parseSidecarArgs('--message "say \\\"hi\\\""')).toEqual([
      '--message',
      'say "hi"',
    ]);
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

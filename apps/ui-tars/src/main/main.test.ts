import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

type ParseSidecarArgs = (rawArgs: string | undefined) => string[];

const extractParseSidecarArgs = (): ParseSidecarArgs => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const signature = 'const parseSidecarArgs =';
  const start = source.indexOf(signature);

  if (start === -1) {
    throw new Error('Could not find parseSidecarArgs in main.ts');
  }

  const bodyStart = source.indexOf('{', start);

  if (bodyStart === -1) {
    throw new Error('Could not find parseSidecarArgs body start');
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
    throw new Error('Could not find parseSidecarArgs body end');
  }

  const statementEnd = source.indexOf(';', bodyEnd);

  if (statementEnd === -1) {
    throw new Error('Could not find parseSidecarArgs statement end');
  }

  const snippet = `${source.slice(start, statementEnd + 1)}\nmodule.exports = { parseSidecarArgs };`;
  const transpiled = transpileModule(snippet, {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} as { parseSidecarArgs: ParseSidecarArgs } };

  new Function('module', 'exports', transpiled)(module, module.exports);

  return module.exports.parseSidecarArgs;
};

describe('parseSidecarArgs', () => {
  const parseSidecarArgs = extractParseSidecarArgs();

  it('keeps quoted values with spaces as a single token', () => {
    expect(
      parseSidecarArgs('--flag "value with spaces" --other "two words"'),
    ).toEqual(['--flag', 'value with spaces', '--other', 'two words']);
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

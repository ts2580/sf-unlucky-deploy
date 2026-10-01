#!/usr/bin/env node

import { createProgram } from './program.js';
import { SfudError } from './core/errors.js';
import { loadHomeConfiguration, shouldLoadHomeConfiguration } from './config/user-config.js';

try {
  const program = createProgram();
  program.hook('preAction', async (_thisCommand, actionCommand) => {
    if (shouldLoadHomeConfiguration(actionCommand.name())) await loadHomeConfiguration();
  });
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof SfudError) {
    process.stderr.write(`[${error.code}] ${error.message}\n`);
  } else if (error instanceof Error) {
    process.stderr.write(`[UNEXPECTED_ERROR] ${error.message}\n`);
  } else {
    process.stderr.write('[UNEXPECTED_ERROR] 알 수 없는 오류가 발생했습니다.\n');
  }
  process.exitCode = 2;
}

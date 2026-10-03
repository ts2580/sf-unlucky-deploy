import { SfudError } from '../core/errors.js';
import { StringDecoder } from 'node:string_decoder';

export interface SetupPrompt {
  interactive: boolean;
  ask(message: string, secret?: boolean): Promise<string>;
  write(message: string): void;
}

/** Raw input keeps secrets out of terminal echo, including pasted input. */
export function terminalSetupPrompt(input = process.stdin, output = process.stdout): SetupPrompt {
  return {
    interactive: input.isTTY === true && output.isTTY === true,
    write: (message) => { output.write(message); },
    ask: async (message, secret = false) => {
      if (input.isTTY !== true || output.isTTY !== true) throw new SfudError('CONFIGURATION_ERROR', '대화형 터미널에서 sfud setup을 실행하세요.');
      output.write(message);
      const wasRaw = input.isRaw;
      const wasPaused = input.isPaused();
      input.setRawMode(true);
      input.resume();
      return new Promise<string>((resolve, reject) => {
        let value = '';
        const decoder = new StringDecoder('utf8');
        let escape: 'none' | 'start' | 'sequence' = 'none';
        const cleanup = () => {
          input.removeListener('data', data);
          input.removeListener('end', ended);
          input.removeListener('error', failed);
          process.removeListener('SIGTERM', cancelled);
          process.removeListener('SIGINT', cancelled);
          input.setRawMode(wasRaw);
          if (wasPaused) input.pause();
          output.write('\n');
        };
        const cancelled = () => { cleanup(); reject(new SfudError('CONFIGURATION_ERROR', '설정을 취소했습니다. 파일을 저장하지 않았습니다.')); };
        const ended = () => cancelled();
        const failed = () => cancelled();
        const data = (chunk: Buffer) => {
          for (const character of decoder.write(chunk)) {
            if (character === '\u0003' || character === '\u0004') { cancelled(); return; }
            if (character === '\u001b') { escape = 'start'; continue; }
            if (escape === 'start') { escape = character === '[' || character === 'O' ? 'sequence' : 'none'; continue; }
            if (escape === 'sequence') { if (character >= '@' && character <= '~') escape = 'none'; continue; }
            if (character === '\r' || character === '\n') { cleanup(); resolve(value); return; }
            if (character === '\u007f' || character === '\b') {
              if (value.length > 0) { value = [...value].slice(0, -1).join(''); if (!secret) output.write('\b \b'); }
            } else if (character >= ' ' && character !== '\u007f' && value.length < 4096) {
              value += character;
              if (!secret) output.write(character);
            }
          }
        };
        input.on('data', data);
        input.once('end', ended);
        input.once('error', failed);
        process.once('SIGTERM', cancelled);
        process.once('SIGINT', cancelled);
      });
    },
  };
}

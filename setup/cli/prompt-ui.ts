export interface SelectOption<T extends string> {
  label: string;
  value: T;
  hint?: string;
}

export interface PromptUi {
  intro(title: string): void;
  note(title: string, body: string): void;
  outro(message: string): void;
  text(args: {
    message: string;
    defaultValue?: string;
    required?: boolean;
    validate?: (value: string) => string | null;
  }): Promise<string>;
  password(args: {
    message: string;
    required?: boolean;
    validate?: (value: string) => string | null;
  }): Promise<string>;
  confirm(args: {
    message: string;
    initialValue?: boolean;
  }): Promise<boolean>;
  select<T extends string>(args: {
    message: string;
    options: SelectOption<T>[];
    initialValue?: T;
  }): Promise<T>;
}

function normalizePromptValue(value: string | null | undefined): string {
  return (value || '').trim();
}

function printDivider(): void {
  console.log('='.repeat(64));
}

async function readHiddenInput(message: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return normalizePromptValue(prompt(`${message}:`));
  }

  return await new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const previousRaw = 'isRaw' in stdin ? Boolean(stdin.isRaw) : false;
    let value = '';

    const cleanup = () => {
      stdin.off('data', onData);
      if (typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(previousRaw);
      }
      stdin.pause();
    };

    const finish = (result: string) => {
      cleanup();
      stdout.write('\n');
      resolve(result);
    };

    const fail = (err: Error) => {
      cleanup();
      stdout.write('\n');
      reject(err);
    };

    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          finish(value);
          return;
        }
        if (ch === '\u0003') {
          fail(new Error('Prompt cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };

    stdout.write(`${message}: `);
    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on('data', onData);
  });
}

export class BunPromptUi implements PromptUi {
  intro(title: string): void {
    printDivider();
    console.log(title);
    printDivider();
  }

  note(title: string, body: string): void {
    console.log(`\n${title}`);
    console.log(body);
  }

  outro(message: string): void {
    console.log(`\n${message}`);
    printDivider();
  }

  async text(args: {
    message: string;
    defaultValue?: string;
    required?: boolean;
    validate?: (value: string) => string | null;
  }): Promise<string> {
    for (;;) {
      const suffix = args.defaultValue ? ` (${args.defaultValue})` : '';
      const value =
        normalizePromptValue(prompt(`${args.message}${suffix}:`)) ||
        args.defaultValue ||
        '';

      if (args.required !== false && !value) {
        console.log('A value is required.');
        continue;
      }

      const error = args.validate?.(value) || null;
      if (error) {
        console.log(error);
        continue;
      }

      return value;
    }
  }

  async password(args: {
    message: string;
    required?: boolean;
    validate?: (value: string) => string | null;
  }): Promise<string> {
    for (;;) {
      const value = normalizePromptValue(await readHiddenInput(args.message));

      if (args.required !== false && !value) {
        console.log('A value is required.');
        continue;
      }

      const error = args.validate?.(value) || null;
      if (error) {
        console.log(error);
        continue;
      }

      return value;
    }
  }

  async confirm(args: {
    message: string;
    initialValue?: boolean;
  }): Promise<boolean> {
    const label = args.initialValue === false ? 'y/N' : 'Y/n';
    for (;;) {
      const value = normalizePromptValue(prompt(`${args.message} (${label}):`));
      if (!value) return args.initialValue !== false;
      if (['y', 'yes'].includes(value.toLowerCase())) return true;
      if (['n', 'no'].includes(value.toLowerCase())) return false;
      console.log('Please answer yes or no.');
    }
  }

  async select<T extends string>(args: {
    message: string;
    options: SelectOption<T>[];
    initialValue?: T;
  }): Promise<T> {
    console.log(`\n${args.message}`);
    args.options.forEach((option, index) => {
      const isDefault = option.value === args.initialValue;
      const defaultLabel = isDefault ? ' (default)' : '';
      const hint = option.hint ? ` - ${option.hint}` : '';
      console.log(`  ${index + 1}. ${option.label}${defaultLabel}${hint}`);
    });

    for (;;) {
      const raw = normalizePromptValue(prompt('Choose a number:'));
      if (!raw && args.initialValue) {
        return args.initialValue;
      }
      const parsed = Number.parseInt(raw, 10);
      if (
        Number.isFinite(parsed) &&
        parsed >= 1 &&
        parsed <= args.options.length
      ) {
        return args.options[parsed - 1].value;
      }
      console.log('Please choose one of the listed numbers.');
    }
  }
}

export function canPromptInteractively(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

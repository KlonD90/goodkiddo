import { z } from 'zod';
import { publicUrl } from '../providers/public-url-policy.js';

export const jobIdSchema = z.string().regex(/^research-[0-9a-f-]{36}$/);
export const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('open'),
    url: z.string().url().max(2000),
  }),
  z.strictObject({ action: z.literal('snapshot') }),
  z.strictObject({ action: z.literal('get_url') }),
  z.strictObject({
    action: z.literal('get_href'),
    ref: z.string().regex(/^@e[1-9]\d{0,5}$/),
  }),
  z.strictObject({
    action: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    amount: z.number().int().min(1).max(2000),
  }),
]);
export type BrowserCommand = z.infer<typeof commandSchema>;

export const requestSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('start'),
    id: z.number().int().nonnegative(),
    jobId: jobIdSchema,
  }),
  z.strictObject({
    type: z.literal('command'),
    id: z.number().int().nonnegative(),
    command: commandSchema,
  }),
  z.strictObject({
    type: z.literal('close'),
    id: z.number().int().nonnegative(),
  }),
]);

// Convert only the fixed app-generated command plans. No arbitrary argv API crosses
// the broker boundary; executable paths, flags and shell syntax are never inputs.
export function parseCommand(
  argv: readonly string[],
  jobId: string,
): BrowserCommand {
  if (
    argv.length < 8 ||
    argv[0] !== '--session' ||
    argv[1] !== jobId ||
    argv[2] !== '--allowed-domains' ||
    argv[4] !== '--content-boundaries' ||
    argv[5] !== '--max-output' ||
    argv[6] !== '20000'
  )
    throw new Error('Invalid browser command plan.');
  const args = argv.slice(7);
  if (args[0] === 'open' && args.length === 2)
    return { action: 'open', url: publicUrl(args[1]).href };
  if (args.join(' ') === 'snapshot -c') return { action: 'snapshot' };
  if (args.join(' ') === 'get url') return { action: 'get_url' };
  if (
    args.length === 4 &&
    args[0] === 'get' &&
    args[1] === 'attr' &&
    args[3] === 'href'
  )
    return commandSchema.parse({ action: 'get_href', ref: args[2] });
  if (args.length === 3 && args[0] === 'scroll')
    return commandSchema.parse({
      action: 'scroll',
      direction: args[1],
      amount: Number(args[2]),
    });
  throw new Error('Read-only browser command is unsupported.');
}

export interface FetchResponse {
  status: number;
  headers: { name: string; value: string }[];
  body: string;
}

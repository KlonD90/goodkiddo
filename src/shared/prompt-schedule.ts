import { CronExpressionParser } from 'cron-parser';

const aliases: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 8 * * *',
  '@weekly': '0 8 * * 1',
  '@monthly': '0 8 1 * *',
};
export function normalizePromptCron(expression: string): string {
  const cron =
    aliases[expression.trim()] || expression.trim().replace(/\s+/g, ' ');
  const fields = cron.split(' ');
  // A single minute per selected hour makes the maximum frequency structural, including DST.
  if (
    fields.length !== 5 ||
    !/^\d{1,2}$/.test(fields[0]) ||
    Number(fields[0]) > 59
  )
    throw new Error(
      'Нужен cron из 5 полей с одной минутой 0–59; задания выполняются не чаще раза в час.',
    );
  return cron;
}
export function nextPromptRun(
  cron: string,
  timezone: string,
  after: Date,
): string {
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format(after);
  const expression = CronExpressionParser.parse(normalizePromptCron(cron), {
    tz: timezone,
    currentDate: after,
  });
  let next = expression.next().toDate();
  // cron-parser 5.5 can skip an existing hour on the spring DST day. Its reverse
  // iterator finds that occurrence; a bounded check prevents quietly skipping it.
  for (let checked = 0; checked < 64; checked++) {
    const previous = expression.prev().toDate();
    if (previous.getTime() <= after.getTime()) return next.toISOString();
    next = previous;
  }
  throw new Error('Не удалось проверить следующее время запуска.');
}

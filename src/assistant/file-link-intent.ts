import type { InboundRequest } from '../shared/assistant-types.js';

/** The authority is this author's current text, never history, a quote or uploaded bytes. */
export function requestedFileLink(
  request: InboundRequest,
  paths: string[],
): boolean {
  if (request.forwarded || !request.userText) return false;
  const text = request.userText
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
  const link =
    /(?:ссылк|браузер|скача|\b(?:link|url|browser|download|share)\b)/iu.test(
      text,
    );
  const artifact =
    /(?:файл|папк|каталог|документ|отч[её]т|таблиц|архив|\b(?:file|folder|directory|document|report|attachment|explorer)\b)/iu.test(
      text,
    ) ||
    paths.some(
      (path) =>
        text.includes(path) || text.includes(path.split('/').at(-1) || '\0'),
    );
  const requestVerb =
    /(?:дай|дайте|пришли|пришлите|отправ|сделай|создай|сгенер|подел|опублику|открой|открыть|скачать|хочу|можно|нужна?|\b(?:give|send|create|generate|share|publish|open|download|please|want|need)\b)/iu.test(
      text,
    );
  const negated =
    /(?:не\s+(?:\S+\s+){0,3}(?:ссылк|публику|подел|отправ)|\b(?:don['’]t|do not|never)\s+(?:\S+\s+){0,3}(?:share|publish|create|send))/iu.test(
      text,
    );
  return link && artifact && requestVerb && !negated;
}

import type { InboundRequest } from '../shared/assistant-types.js';

/** Only the current author's direct instruction authorizes exposing an artifact. */
export function requestedMiniPage(
  request: InboundRequest,
  path: string,
): boolean {
  if (request.forwarded || request.scheduled || !request.userText) return false;
  const text = request.userText
    .replace(/```[\s\S]*?```|`[^`]*`/g, '')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
  const page =
    /(?:страниц|сайт|лендинг|\b(?:mini[ -]?page|web[ -]?page|website|landing|html)\b)/iu.test(
      text,
    ) || text.includes(path);
  const instruction =
    /(?:сделай|создай|сгенер|опублику|размест|пришли|дай|нужн|хочу|\b(?:create|make|generate|publish|host|share|send|give|need|want)\b)/iu.test(
      text,
    );
  const negative =
    /(?:не\s+(?:\S+\s+){0,3}(?:публику|размещ|ссылк|созда|делай|отправ|подел|выклад)|без\s+(?:публикац|ссылк|отправ|размещ)|черновик|\b(?:draft|don['’]t|do not|never)\b|\b(?:without|not)\s+(?:\S+\s+){0,3}(?:publish|share|host|link|send))/iu.test(
      text,
    );
  return page && instruction && !negative;
}

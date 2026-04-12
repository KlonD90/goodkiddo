import {
  SupportedAiTypes,
  checkAiType,
  UsingMode,
  checkUsingMode,
} from "./types";

export const AI_API_KEY: string = (process.env.AI_API_KEY as string) || "";
export const AI_BASE_URL: string = (process.env.AI_BASE_URL as string) || "";
export const AI_TYPE: SupportedAiTypes =
  (process.env.AI_TYPE as SupportedAiTypes) || "anthropic";
export const AI_MODEL_NAME: string =
  (process.env.AI_MODEL_NAME as string) || "";

if (!checkAiType(AI_TYPE)) {
  throw new Error(`Invalid AI_TYPE: ${AI_TYPE}`);
}

export const USING_MODE: UsingMode =
  (process.env.USING_MODE as UsingMode) || "single";
if (!checkUsingMode(USING_MODE)) {
  throw new Error(
    `Invalid USING_MODE: ${USING_MODE}, available options are "single" or "multi"`,
  );
}

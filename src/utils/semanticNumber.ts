import { z } from "zod";

export function semanticNumber<T extends z.ZodType>(
  inner: T = z.number() as unknown as T,
) {
  return z.preprocess((v: unknown) => {
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return v;
  }, inner);
}

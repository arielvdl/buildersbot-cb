import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/guard";

export const messages = {} as const satisfies PartialTranslation<typeof source>;

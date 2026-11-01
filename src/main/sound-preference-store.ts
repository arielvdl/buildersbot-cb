import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  CUSTOM_SOUND_EXTENSIONS,
  CUSTOM_SOUND_LIMIT,
  CUSTOM_SOUND_MAX_BYTES,
  type CustomSound,
  DEFAULT_SOUND_PREFERENCE,
  decodeSoundPreference,
  isCustomSoundId,
  RECENT_SOUND_LIMIT,
  type RecentSound,
  type SoundCenterState,
  type SoundPlayReport,
  type SoundPreference,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result, Schema, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

export const SOUND_PREFERENCE_FILE = "openbot-sound-preference-v1.json";
/** The folder in the app data where main keeps its copies of the custom sound files. */
export const CUSTOM_SOUND_FOLDER = "sounds";

type CustomSoundExtension = (typeof CUSTOM_SOUND_EXTENSIONS)[number];

export class CustomSoundFailure extends Schema.TaggedError<CustomSoundFailure>()("CustomSoundFailure", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

interface StoredSoundPreference extends SoundPreference {
  customSounds: CustomSound[];
}

/**
 * Whether the first bytes of a file are of the type its extension names. The file is never run: the
 * check only keeps a renamed file of another type out of the sound folder.
 */
export function customSoundBytesMatch(extension: CustomSoundExtension, head: Uint8Array): boolean {
  const text = (start: number, end: number) => String.fromCharCode(...head.subarray(start, end));
  switch (extension) {
    case "wav":
      return text(0, 4) === "RIFF" && text(8, 12) === "WAVE";
    case "aiff":
      return text(0, 4) === "FORM" && (text(8, 12) === "AIFF" || text(8, 12) === "AIFC");
    case "ogg":
      return text(0, 4) === "OggS";
    case "m4a":
      return text(4, 8) === "ftyp";
    case "mp3":
      // An ID3 tag, or an MPEG audio frame sync.
      return text(0, 3) === "ID3" || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0);
  }
}

function customSoundExtension(path: string): CustomSoundExtension | null {
  const extension = extname(path).slice(1).toLowerCase();
  const normalized = extension === "aif" ? "aiff" : extension;
  return isOneOf(CUSTOM_SOUND_EXTENSIONS, normalized) ? normalized : null;
}

function decodeStored(parsed: unknown): StoredSoundPreference | null {
  if (!isDynamicRecord(parsed) || parsed.version !== 1) return null;
  try {
    const preference = decodeSoundPreference(parsed);
    const customSounds = Array.isArray(parsed.customSounds)
      ? parsed.customSounds.flatMap((value): CustomSound[] =>
          isDynamicRecord(value) && isCustomSoundId(value.id) && isString(value.name) && isNumber(value.bytes)
            ? [{ id: value.id, name: value.name, bytes: value.bytes }]
            : [],
        )
      : [];
    return { ...preference, customSounds };
  } catch {
    return null;
  }
}

/**
 * The sound center of this computer: the preference, the custom sound files and the Recent sounds
 * list. Main holds it in memory after `load`, because each macOS notification reads it. The Recent
 * sounds list is in memory only: it helps to find a sound that plays now, and holds no message text.
 *
 * Writes are chained for the reason `update-preference-store.ts` chains its own.
 */
export class SoundPreferenceStore {
  readonly #path: string;
  readonly #folder: string;
  #stored: StoredSoundPreference = { ...DEFAULT_SOUND_PREFERENCE, customSounds: [] };
  #saved = false;
  #recent: RecentSound[] = [];
  readonly #listeners = new Set<(state: SoundCenterState) => void>();
  #writes = Semaphore.makeUnsafe(1);

  constructor(options: { userData: string }) {
    this.#path = join(options.userData, SOUND_PREFERENCE_FILE);
    this.#folder = join(options.userData, CUSTOM_SOUND_FOLDER);
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(readPreferenceFile(this.#path, decodeStored));
      if (Result.isSuccess(loaded)) {
        if (loaded.success) {
          this.#stored = loaded.success;
          this.#saved = true;
        }
      } else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  preference(): SoundPreference {
    return { muteAll: this.#stored.muteAll, events: { ...this.#stored.events } };
  }

  state(): SoundCenterState {
    return {
      preference: this.preference(),
      saved: this.#saved,
      customSounds: this.#stored.customSounds.map((sound) => ({ ...sound })),
      recent: this.#recent.map((entry) => ({ ...entry })),
    };
  }

  /** Called with the new state after each change, so main can send it to each window. */
  subscribe(listener: (state: SoundCenterState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  readonly set = Effect.fn("SoundPreference.set")(function* (this: SoundPreferenceStore, preference: SoundPreference) {
    yield* this.#write((stored) => ({ ...stored, muteAll: preference.muteAll, events: { ...preference.events } }));
    this.#saved = true;
    this.#emit();
    return this.state();
  });

  /** Adds one entry to Recent sounds. */
  report(report: SoundPlayReport, at: Date = new Date()): void {
    this.#recent = [{ ...report, at: at.toISOString() }, ...this.#recent].slice(0, RECENT_SOUND_LIMIT);
    this.#emit();
  }

  /**
   * Checks a file that the person chose and copies it into the sound folder. The type comes from the
   * extension and must match the first bytes; the size has a limit. The renderer never reads the
   * chosen path: it gets the bytes of the copy by its id.
   */
  readonly addCustomSound = Effect.fn("SoundPreference.addCustomSound")(function* (
    this: SoundPreferenceStore,
    sourcePath: string,
  ) {
    const extension = customSoundExtension(sourcePath);
    if (!extension) return yield* customFailure("error.app.customSoundType");
    const bytes = yield* Effect.tryPromise({
      try: async () => {
        const info = await stat(sourcePath);
        if (!info.isFile()) return null;
        if (info.size === 0 || info.size > CUSTOM_SOUND_MAX_BYTES) return info.size;
        return readFile(sourcePath);
      },
      catch: (cause) => new CustomSoundFailure({ message: sourceText("error.app.customSoundUnreadable"), cause }),
    });
    if (bytes === null) return yield* customFailure("error.app.customSoundUnreadable");
    if (typeof bytes === "number") return yield* customFailure("error.app.customSoundSize");
    if (!customSoundBytesMatch(extension, bytes.subarray(0, 16)))
      return yield* customFailure("error.app.customSoundType");
    const id = `${randomUUID()}.${extension}`;
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(this.#folder, { recursive: true, mode: 0o700 });
        await writeFile(join(this.#folder, id), bytes, { mode: 0o600, flag: "wx" });
      },
      catch: (cause) => new CustomSoundFailure({ message: sourceText("error.app.customSoundUnreadable"), cause }),
    });
    const added: CustomSound = { id, name: basename(sourcePath).slice(0, 120), bytes: bytes.byteLength };
    const dropped: string[] = [];
    yield* this.#write((stored) => {
      const used = new Set(
        Object.values(stored.events).flatMap((event) => (event?.customSoundId ? [event.customSoundId] : [])),
      );
      let customSounds = [...stored.customSounds, added];
      // The oldest file that no sound uses goes first. A list where each file is in use keeps them all.
      while (customSounds.length > CUSTOM_SOUND_LIMIT) {
        const unused = customSounds.find((sound) => !used.has(sound.id) && sound.id !== id);
        if (!unused) break;
        dropped.push(unused.id);
        customSounds = customSounds.filter((sound) => sound !== unused);
      }
      return { ...stored, customSounds };
    });
    for (const old of dropped)
      yield* Effect.promise(() => rm(join(this.#folder, old), { force: true }).catch(() => undefined));
    this.#emit();
    return added;
  });

  /** The bytes of a copied custom sound. Only an id of a file in the list can be read. */
  readonly readCustomSound = Effect.fn("SoundPreference.readCustomSound")(function* (
    this: SoundPreferenceStore,
    id: string,
  ) {
    if (!isCustomSoundId(id) || !this.#stored.customSounds.some((sound) => sound.id === id))
      return yield* customFailure("error.app.customSoundMissing");
    const path = join(this.#folder, id);
    return yield* Effect.tryPromise({
      try: async () => {
        const handle = await open(path, "r");
        try {
          const { size } = await handle.stat();
          if (size > CUSTOM_SOUND_MAX_BYTES) throw new Error("The custom sound file grew past its limit.");
          return new Uint8Array(await handle.readFile());
        } finally {
          await handle.close();
        }
      },
      catch: (cause) => new CustomSoundFailure({ message: sourceText("error.app.customSoundMissing"), cause }),
    });
  });

  #emit(): void {
    const state = this.state();
    for (const listener of this.#listeners) listener(state);
  }

  #write(change: (stored: StoredSoundPreference) => StoredSoundPreference): Effect.Effect<void, PreferenceFileFailure> {
    return this.#writes.withPermit(
      Effect.uninterruptible(
        Effect.suspend(() => {
          const next = change(this.#stored);
          return writePreferenceFile(this.#path, { version: 1, ...next }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                this.#stored = next;
              }),
            ),
          );
        }),
      ),
    );
  }
}

type CustomSoundError =
  | "error.app.customSoundType"
  | "error.app.customSoundSize"
  | "error.app.customSoundUnreadable"
  | "error.app.customSoundMissing";

function customFailure(key: CustomSoundError): Effect.Effect<never, CustomSoundFailure> {
  const message = sourceText(key);
  return Effect.fail(new CustomSoundFailure({ message, cause: new Error(message) }));
}

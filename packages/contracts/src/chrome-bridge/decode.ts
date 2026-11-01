/**
 * Closed decoders for the Chrome bridge. The extension service worker runs them too, so they use no
 * Node, no Electron and no Effect: plain functions over JSON values.
 *
 * Every object is closed. A key that the shape does not name fails the decode, because a field that one
 * side adds and the other ignores is how a protocol grows a hole. Strings, arrays and numbers have
 * fixed bounds, so a peer cannot make the other side hold an unbounded value.
 */

import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "../runtime-values";

export type Decoded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export type Decoder<T> = (value: unknown, path: string) => Decoded<T>;

const ok = <T>(value: T): Decoded<T> => ({ ok: true, value });
const fail = (path: string, reason: string): Decoded<never> => ({ ok: false, error: `${path || "value"}: ${reason}` });

export function text(options: { max: number; min?: number; pattern?: RegExp }): Decoder<string> {
  return (value, path) => {
    if (!isString(value)) return fail(path, "expected a string");
    if (value.length < (options.min ?? 0)) return fail(path, "too short");
    if (value.length > options.max) return fail(path, "too long");
    if (options.pattern && !options.pattern.test(value)) return fail(path, "has the wrong form");
    return ok(value);
  };
}

export function literal<const T extends string>(values: readonly T[]): Decoder<T> {
  return (value, path) => (isOneOf(values, value) ? ok(value) : fail(path, `expected one of ${values.join(", ")}`));
}

export function integer(min: number, max: number): Decoder<number> {
  return (value, path) =>
    isNumber(value) && Number.isSafeInteger(value) && value >= min && value <= max
      ? ok(value)
      : fail(path, `expected an integer from ${min} to ${max}`);
}

export function finite(min: number, max: number): Decoder<number> {
  return (value, path) =>
    isNumber(value) && Number.isFinite(value) && value >= min && value <= max
      ? ok(value)
      : fail(path, `expected a number from ${min} to ${max}`);
}

export const boolean: Decoder<boolean> = (value, path) =>
  isBoolean(value) ? ok(value) : fail(path, "expected a boolean");

export function list<T>(item: Decoder<T>, max: number): Decoder<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) return fail(path, "expected an array");
    if (value.length > max) return fail(path, `holds more than ${max} items`);
    const items: T[] = [];
    for (const [index, entry] of value.entries()) {
      const decoded = item(entry, `${path}[${index}]`);
      if (!decoded.ok) return decoded;
      items.push(decoded.value);
    }
    return ok(items);
  };
}

type Shape = Readonly<Record<string, Decoder<unknown>>>;
type Out<S extends Shape> = { [K in keyof S]: S[K] extends Decoder<infer T> ? T : never };
type Closed<R extends Shape, O extends Shape> = Out<R> & Partial<Out<O>>;

/**
 * A closed object: the `required` keys must be present, the `optional` ones may be, and no other key
 * may. The value passes through as it is: every decoder here checks and does not convert, so the object
 * that passed the checks is the decoded value.
 */
export function record<R extends Shape, O extends Shape = Record<never, Decoder<never>>>(
  required: R,
  optional?: O,
): Decoder<Closed<R, O>> {
  const problem = (value: unknown, path: string): string | null => {
    if (!isDynamicRecord(value)) return `${path || "value"}: expected an object`;
    const at = (key: string) => (path ? `${path}.${key}` : key);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(required, key) && !(optional && Object.hasOwn(optional, key)))
        return `${at(key)}: is not a known field`;
    }
    for (const [key, decoder] of Object.entries(required)) {
      if (!Object.hasOwn(value, key)) return `${at(key)}: is missing`;
      const decoded = decoder(value[key], at(key));
      if (!decoded.ok) return decoded.error;
    }
    for (const [key, decoder] of Object.entries(optional ?? {})) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) continue;
      const decoded = decoder(value[key], at(key));
      if (!decoded.ok) return decoded.error;
    }
    return null;
  };
  return (value, path) => {
    let error: string | null = null;
    const fits = (candidate: unknown): candidate is Closed<R, O> => {
      error = problem(candidate, path);
      return error === null;
    };
    return fits(value) ? ok(value) : { ok: false, error: error ?? `${path || "value"}: is not valid` };
  };
}

/**
 * Any JSON value up to `maxBytes` of its UTF-8 text, for a payload whose meaning the other side
 * checks, such as the parameters of a CDP command. Cycles cannot occur in parsed JSON.
 */
export function json(maxBytes: number): Decoder<unknown> {
  return (value, path) => {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return fail(path, "is not JSON");
    }
    if (serialized === undefined) return fail(path, "is not JSON");
    if (utf8Length(serialized) > maxBytes) return fail(path, `is larger than ${maxBytes} bytes`);
    return ok(value);
  };
}

/** The UTF-8 length of a string, without TextEncoder, which the contracts package does not assume. */
export function utf8Length(value: string) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

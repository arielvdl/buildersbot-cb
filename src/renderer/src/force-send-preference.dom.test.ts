// The "Ask before forcing a message" choice of this device and browser: it asks by default, the
// dialog's "Don't ask me again" stops it, and the Settings switch brings it back.
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { readAskBeforeForce, setAskBeforeForce, useAskBeforeForce } from "./force-send-preference";

const KEY = "openbot:ask-before-force-send";

afterEach(() => {
  setAskBeforeForce(true);
  flush();
  window.localStorage.clear();
});

describe("the ask-before-force preference", () => {
  it("asks when nothing is stored", () => {
    window.localStorage.removeItem(KEY);
    expect(readAskBeforeForce()).toBe(true);
  });

  it("stops asking after “Don’t ask me again”, and the switch undoes it", () => {
    const ask = useAskBeforeForce();
    setAskBeforeForce(false);
    flush();
    expect(ask()).toBe(false);
    expect(readAskBeforeForce()).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe("false");
    setAskBeforeForce(true);
    flush();
    expect(ask()).toBe(true);
    expect(readAskBeforeForce()).toBe(true);
  });

  it("follows a change that another window of the same browser saved", () => {
    const ask = useAskBeforeForce();
    window.localStorage.setItem(KEY, "false");
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "false" }));
    flush();
    expect(ask()).toBe(false);
  });
});

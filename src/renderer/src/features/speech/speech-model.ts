import { SPEECH_MODEL, type SpeechModelStatus } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { toast } from "@openbot/ui";
import { currentText } from "@openbot/ui/text";
import { createSignal } from "solid-js";
import { speechPort } from "./speech-port";
import { voiceServer } from "./voice-server";

/** One notice at a time: a second "Read aloud" replaces it rather than stacking a copy. */
const DOWNLOAD_OFFER_TOAST_ID = "speech-model-download-offer";

/** Null until main tells the status: then the renderer does not know yet if the voice is here. */
const [status, setStatus] = createSignal<SpeechModelStatus | null>(null);
let following = false;

/** Starts to follow the model status on the first read. */
function followStatus(): void {
  if (following) return;
  following = true;
  const voice = speechPort().voice;
  voice.onSpeechModelStatus((next) => setStatus(next));
  void voice.getSpeechModelStatus().then(
    (next) => setStatus((current) => current ?? next),
    () => undefined,
  );
}

/**
 * Whether a reply can be read aloud: the speech model is on this computer, or the user's own voice
 * server speaks. The first read starts to follow the model status; the answer is false until main
 * tells it.
 */
export function speechModelReady(): boolean {
  followStatus();
  return status()?.phase === "ready" || voiceServer()?.routes.speech === true;
}

/**
 * Whether a download of the voice can make "Read aloud" work: the voice is not on this computer, or
 * its last download failed. A build with no speech runtime also reports an error, but a download
 * does not repair it. A status that main did not send yet, and a download that runs now, answer false.
 */
export function speechDownloadHelps(next: SpeechModelStatus | null | undefined): boolean {
  if (next?.phase === "missing") return true;
  return next?.phase === "error" && next.message !== sourceText("error.voice.speech.runtimeUnavailable");
}

/**
 * Whether "Read aloud" stays in the menu of a reply to offer the voice download. False while a
 * voice server speaks, because then the reply is read without the voice of this computer.
 */
export function speechModelOffersDownload(): boolean {
  followStatus();
  return voiceServer()?.routes.speech !== true && speechDownloadHelps(status());
}

/**
 * Tells that the voice that reads replies is not on this computer, with its download as the action.
 * "Read aloud" stays an active menu item without the voice: a disabled item gets no focus, so the
 * reason would not reach the keyboard or a screen reader. The size comes from the model manifest.
 */
export function offerSpeechModelDownload(): void {
  const { t, format } = currentText();
  toast(t("conversation.speech.voiceMissing"), {
    id: DOWNLOAD_OFFER_TOAST_ID,
    action: {
      label: t("conversation.speech.downloadVoice", { size: format.fileSize(SPEECH_MODEL.bytes) }),
      onClick: () => void downloadSpeechModel(),
    },
  });
}

/** Downloads the voice. The status event makes "Read aloud" read when the download ends. */
async function downloadSpeechModel(): Promise<void> {
  const { t } = currentText();
  const fallback = t("settings.voice.downloadFailed");
  const report = { operation: "voice", source: "action", cause_code: "unknown" } as const;
  try {
    const status = await speechPort().voice.downloadSpeechModel();
    if (status.phase === "error") toast.error(currentText().errorMessage(status.message, fallback), { report });
  } catch (error) {
    toast.error(currentText().errorMessage(error, fallback), { report });
  }
}

import { SPEECH_MODEL, type SpeechModelStatus } from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { currentText } from "@openbot/ui/text";
import { createSignal } from "solid-js";
import { speechPort } from "./speech-port";
import { voiceServer } from "./voice-server";

/** One notice at a time: a second "Read aloud" replaces it rather than stacking a copy. */
const DOWNLOAD_OFFER_TOAST_ID = "speech-model-download-offer";

const [status, setStatus] = createSignal<SpeechModelStatus["phase"] | null>(null);
let following = false;

/**
 * Whether a reply can be read aloud: the speech model is on this computer, or the user's own voice
 * server speaks. The first read starts to follow the model status; the answer is false until main
 * tells it.
 */
export function speechModelReady(): boolean {
  if (!following) {
    following = true;
    const voice = speechPort().voice;
    voice.onSpeechModelStatus((next) => setStatus(next.phase));
    void voice.getSpeechModelStatus().then(
      (next) => setStatus((current) => current ?? next.phase),
      () => undefined,
    );
  }
  return status() === "ready" || voiceServer()?.routes.speech === true;
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

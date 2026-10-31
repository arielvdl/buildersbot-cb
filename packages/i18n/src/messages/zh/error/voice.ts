import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/voice";

export const messages = {
  // Voice transcription errors.
  "error.voice.downloadFailed": "无法下载语音模型，请重试。",
  "error.voice.downloadStopped": "语音模型下载已停止。",
  "error.voice.removeBusy": "请等语音转写结束后再移除该模型。",
  "error.voice.removeFailed": "无法移除语音模型，请重试。",
  "error.voice.runtimeUnavailable": "该平台不支持本地语音转写。",
  "error.voice.busy": "已有语音转写正在进行。",
  "error.voice.modelUnavailable": "语音模型不可用。",
  "error.voice.transcriptionTimedOut": "语音转写超时。",
  "error.voice.prepareRequired": "本地语音转写不可用。请运行 `bun run voice:prepare` 并重启 Builders Bot。",
  "error.voice.transcriptionFailed": "Builders Bot 无法转写这段录音。",
  "error.voice.cloud.keyRequired": "请在“设置 → 语音”中添加 ElevenLabs API 密钥。",
  "error.voice.cloud.keyRejected": "ElevenLabs 未接受该 API 密钥，请在“设置 → 语音”中检查。",
  "error.voice.cloud.quotaExceeded": "你的 ElevenLabs 配额已用完。",
  "error.voice.cloud.rateLimited": "ElevenLabs 正忙，请稍后重试。",
  "error.voice.cloud.termsRequired": "请先在你的 ElevenLabs 账号中接受条款，然后重试。",
  "error.voice.cloud.streamEnded": "听写流已结束，请重新录制。",
  "error.voice.cloud.tooLong": "录音过长。",
  "error.voice.cloud.keySaveFailed": "无法保存 ElevenLabs API 密钥。",
  "error.voice.cloud.keyUnreadable": "Builders Bot 无法读取已保存的 API 密钥。请使用本地听写，或移除该密钥。",
  "error.voice.speech.runtimeUnavailable": "该平台不支持本地语音。",
  "error.voice.speech.modelRequired": "请在“设置 → 语音”中下载语音模型。",
  "error.voice.speech.timedOut": "朗读回复超时。",
  "error.voice.speech.failed": "Builders Bot 无法朗读该回复。",
  "error.voice.recordingNotKept": "Builders Bot 无法保留该录音。",
  "error.voice.server.keyUnreadable": "Builders Bot 无法读取你的语音服务器已保存的密钥。请重新输入密钥，或将其移除。",
} as const satisfies PartialTranslation<typeof source>;

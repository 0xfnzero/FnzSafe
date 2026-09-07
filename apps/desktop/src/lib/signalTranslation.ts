export type SignalTranslationTarget = "zh-CN" | "en";

const TRANSLATION_NOISE_RE = /(?:https?:\/\/\S+|0x[a-fA-F0-9]{40,64}|[1-9A-HJ-NP-Za-km-z]{32,44}|[@#$][\p{L}\p{N}_]+)/gu;
const HAN_RE = /[\p{Script=Han}]/gu;
const LATIN_RE = /[A-Za-z]/g;

export function signalTranslationTarget(
  text: string,
  locale: "zh" | "en",
): SignalTranslationTarget | undefined {
  const content = text.replace(TRANSLATION_NOISE_RE, " ");
  const hanCount = content.match(HAN_RE)?.length ?? 0;
  const latinCount = content.match(LATIN_RE)?.length ?? 0;
  if (locale === "zh") {
    return latinCount >= 8 && latinCount >= hanCount * 2 ? "zh-CN" : undefined;
  }
  return hanCount >= 2 ? "en" : undefined;
}

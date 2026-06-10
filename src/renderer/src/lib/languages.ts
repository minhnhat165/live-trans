// BCP-47 codes accepted by gemini-3.5-live-translate-preview (subset of the 70+ supported).
export type Lang = { code: string; label: string }

export const LANGUAGES: Lang[] = [
  { code: 'en', label: 'English' },
  { code: 'vi', label: 'Tiếng Việt (Vietnamese)' },
  { code: 'zh-Hans', label: '中文 简体 (Chinese, Simplified)' },
  { code: 'zh-Hant', label: '中文 繁體 (Chinese, Traditional)' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'ja', label: '日本語 (Japanese)' },
  { code: 'ko', label: '한국어 (Korean)' },
  { code: 'es', label: 'Español (Spanish)' },
  { code: 'fr', label: 'Français (French)' },
  { code: 'de', label: 'Deutsch (German)' },
  { code: 'it', label: 'Italiano (Italian)' },
  { code: 'pt', label: 'Português (Portuguese)' },
  { code: 'ru', label: 'Русский (Russian)' },
  { code: 'ar', label: 'العربية (Arabic)' },
  { code: 'id', label: 'Bahasa Indonesia (Indonesian)' },
  { code: 'th', label: 'ไทย (Thai)' },
  { code: 'tr', label: 'Türkçe (Turkish)' },
  { code: 'pl', label: 'Polski (Polish)' },
  { code: 'nl', label: 'Nederlands (Dutch)' },
  { code: 'uk', label: 'Українська (Ukrainian)' },
  { code: 'bn', label: 'বাংলা (Bengali)' },
  { code: 'ta', label: 'தமிழ் (Tamil)' },
  { code: 'te', label: 'తెలుగు (Telugu)' },
  { code: 'mr', label: 'मराठी (Marathi)' },
  { code: 'ur', label: 'اردو (Urdu)' },
  { code: 'fa', label: 'فارسی (Persian)' },
  { code: 'he', label: 'עברית (Hebrew)' },
  { code: 'el', label: 'Ελληνικά (Greek)' },
  { code: 'cs', label: 'Čeština (Czech)' },
  { code: 'sv', label: 'Svenska (Swedish)' },
  { code: 'ro', label: 'Română (Romanian)' },
  { code: 'hu', label: 'Magyar (Hungarian)' },
  { code: 'fi', label: 'Suomi (Finnish)' },
  { code: 'da', label: 'Dansk (Danish)' },
  { code: 'no', label: 'Norsk (Norwegian)' },
  { code: 'ms', label: 'Bahasa Melayu (Malay)' },
  { code: 'fil', label: 'Filipino' }
]

export function labelFor(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code
}

import english from "./locales/en.js";
import french from "./locales/fr.js";

// Fixed catalog data; the locale is carried by each returned translator.
export const CATALOGS = Object.freeze({
  en: Object.freeze(english),
  fr: Object.freeze(french),
});
export const LANGUAGES = Object.freeze(["en", "fr"]);
const placeholders = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

export function createI18n(locale = "en", messages = CATALOGS[locale]) {
  if (!LANGUAGES.includes(locale)) throw new Error(english["language.invalid"].replace("{value}", () => String(locale)));
  const selected = Object.freeze({ ...messages });
  const t = (key, params = {}) => {
    const template = selected[key] ?? CATALOGS.en[key];
    if (typeof template !== "string") throw new Error("Unknown translation key: " + key);
    return template.replace(placeholders, (_match, name) => {
      if (!Object.hasOwn(params, name)) throw new Error("Missing translation parameter: " + key + "." + name);
      return String(params[name]);
    });
  };
  return Object.freeze({ locale, t });
}

// Select once before command parsing or mutations. An explicit CLI selector
// wins even if the environment value is invalid. Never infer an OS locale.
export function extractLanguage(argv, env = process.env) {
  const args = [];
  let explicit;
  const fallback = createI18n(env.FTP_MCP_LANG === "fr" ? "fr" : "en");
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--lang") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("-")) throw new Error(fallback.t("language.missing"));
      if (!LANGUAGES.includes(value)) throw new Error(fallback.t("language.invalid", { value }));
      explicit = value;
    } else if (token.startsWith("--lang=")) {
      explicit = token.slice("--lang=".length);
      if (!LANGUAGES.includes(explicit)) throw new Error(fallback.t("language.invalid", { value: explicit }));
    } else args.push(token);
  }
  const locale = explicit ?? env.FTP_MCP_LANG ?? "en";
  if (!LANGUAGES.includes(locale)) throw new Error(fallback.t("language.invalid", { value: locale }));
  return Object.freeze({ argv: args, locale });
}

export function affirmative(value) {
  return /^(?:y|yes|o|oui)$/i.test(String(value).trim());
}
export function negative(value) {
  return /^(?:n|no|non)$/i.test(String(value).trim());
}

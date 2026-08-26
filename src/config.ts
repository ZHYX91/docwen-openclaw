import { Type } from "typebox";

export const SUPPORTED_LANGUAGES = [
  "auto",
  "zh_CN",
  "zh_TW",
  "en_US",
  "ja_JP",
  "ko_KR",
  "fr_FR",
  "de_DE",
  "es_ES",
  "pt_BR",
  "ru_RU",
  "vi_VN",
] as const;

export const docwenConfigSchema = Type.Object(
  {
    binaryPath: Type.Optional(Type.String({ minLength: 1 })),
    language: Type.Optional(
      Type.Union(
        [
          Type.Literal("auto"),
          Type.Literal("zh_CN"),
          Type.Literal("zh_TW"),
          Type.Literal("en_US"),
          Type.Literal("ja_JP"),
          Type.Literal("ko_KR"),
          Type.Literal("fr_FR"),
          Type.Literal("de_DE"),
          Type.Literal("es_ES"),
          Type.Literal("pt_BR"),
          Type.Literal("ru_RU"),
          Type.Literal("vi_VN"),
        ],
        { default: "auto" },
      ),
    ),
    readTimeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 1_800_000, default: 30_000 })),
    writeTimeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 1_800_000, default: 600_000 })),
  },
  { additionalProperties: false },
);

export type DocWenPluginConfig = {
  binaryPath?: string;
  language?: (typeof SUPPORTED_LANGUAGES)[number];
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
};

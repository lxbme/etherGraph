export const en = {
  "settings.title": "Settings",
  "settings.language": "Language",
  "settings.theme": "Theme",
  "settings.theme.light": "Light",
  "settings.theme.dark": "Dark",
  "settings.theme.system": "System",
  "test.hello": "Hello, {name}",
  "test.items": { one: "{count} item", other: "{count} items" },
} as const;

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : { one: string; other: string } };
export type Messages = Widen<typeof en>;
export type MsgKey = keyof typeof en;

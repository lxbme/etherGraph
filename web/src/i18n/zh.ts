import type { en, MsgKey } from "./en";

export const zh: { [K in MsgKey]: (typeof en)[K] extends string ? string : { one: string; other: string } } = {
  "settings.title": "设置",
  "settings.language": "语言",
  "settings.theme": "主题",
  "settings.theme.light": "浅色",
  "settings.theme.dark": "深色",
  "settings.theme.system": "跟随系统",
  "test.hello": "你好，{name}",
  "test.items": { one: "{count} 项", other: "{count} 项" },
};

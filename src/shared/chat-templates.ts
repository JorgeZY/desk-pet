export const CHAT_TEMPLATE_COUNT = 3;
export const CHAT_TEMPLATE_MAX_LENGTH = 80;

export const DEFAULT_CHAT_TEMPLATES = [
  "给今天的我来一句橘猫式鼓励",
  "用橘猫口吻吐槽一下加班",
  "编一个橘猫偷吃却拒不承认的故事",
] as const;

export function normalizeChatTemplates(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_CHAT_TEMPLATES];
  return Array.from({ length: CHAT_TEMPLATE_COUNT }, (_item, index) => {
    const template = value[index];
    return typeof template === "string"
      ? template.trim().slice(0, CHAT_TEMPLATE_MAX_LENGTH)
      : "";
  });
}

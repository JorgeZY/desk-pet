export const PET_WINDOW_BASE_HEIGHT = 390;
export const PET_WINDOW_MAX_HEIGHT = 630;
export const QUICK_REPLY_COLLAPSED_HEIGHT = 34;
export const QUICK_REPLY_MAX_HEIGHT = 274;

const PET_WINDOW_GROWTH_STEP = 48;

export function quickReplyWindowHeight(scrollHeight: number, expanded: boolean): number {
  if (!expanded) return PET_WINDOW_BASE_HEIGHT;

  const replyHeight = Math.min(
    QUICK_REPLY_MAX_HEIGHT,
    Math.max(QUICK_REPLY_COLLAPSED_HEIGHT, Math.ceil(scrollHeight)),
  );
  const extraHeight = replyHeight - QUICK_REPLY_COLLAPSED_HEIGHT;
  const steppedExtraHeight = Math.ceil(extraHeight / PET_WINDOW_GROWTH_STEP) * PET_WINDOW_GROWTH_STEP;

  return Math.min(PET_WINDOW_MAX_HEIGHT, PET_WINDOW_BASE_HEIGHT + steppedExtraHeight);
}

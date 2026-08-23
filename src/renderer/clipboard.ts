interface CopyTextFallbacks {
  desktopCopyText?: (text: string) => Promise<void>;
  browserCopyText?: (text: string) => Promise<void>;
  legacyCopyText?: (text: string) => boolean;
}

export async function copyTextWithFallback(
  text: string,
  fallbacks: CopyTextFallbacks,
): Promise<void> {
  let lastError: unknown;

  for (const copyText of [fallbacks.desktopCopyText, fallbacks.browserCopyText]) {
    if (!copyText) continue;
    try {
      await copyText(text);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (fallbacks.legacyCopyText) {
    try {
      if (fallbacks.legacyCopyText(text)) return;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error("当前环境不支持复制到剪贴板");
}

export function copyTextViaDocument(text: string, targetDocument: Document): boolean {
  const textArea = targetDocument.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.inset = "0 auto auto -9999px";
  textArea.style.opacity = "0";
  targetDocument.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    return targetDocument.execCommand("copy");
  } finally {
    textArea.remove();
  }
}

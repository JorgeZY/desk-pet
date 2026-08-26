import type { WindowMode } from "../shared/types";

export type WorkbenchDestination = "chat" | "settings" | "pet";

export function shouldUpdateRendererView(
  windowKind: string | null,
  nextView: WindowMode,
): boolean {
  // Each renderer belongs to one long-lived native window. Hiding the
  // workbench for pet mode must not unmount its chat/session controller.
  return windowKind === "workbench" && nextView !== "pet";
}

export function confirmWorkbenchNavigation(
  currentView: WorkbenchDestination,
  nextView: WorkbenchDestination,
  settingsDirty: boolean,
  confirmDiscard: () => boolean,
): boolean {
  if (currentView !== "settings" || nextView === "settings" || !settingsDirty) return true;
  return confirmDiscard();
}

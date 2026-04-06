import type { ProviderInteractionMode } from "@t3tools/contracts";

export function shouldResetInteractionModeDraftOverride(input: {
  draftInteractionMode: ProviderInteractionMode | null | undefined;
  previousServerInteractionMode: ProviderInteractionMode | null | undefined;
  nextServerInteractionMode: ProviderInteractionMode | null | undefined;
}): boolean {
  const draftInteractionMode = input.draftInteractionMode ?? null;
  const previousServerInteractionMode = input.previousServerInteractionMode ?? null;
  const nextServerInteractionMode = input.nextServerInteractionMode ?? null;

  if (
    draftInteractionMode === null ||
    previousServerInteractionMode === null ||
    nextServerInteractionMode === null
  ) {
    return false;
  }

  return (
    previousServerInteractionMode !== nextServerInteractionMode &&
    draftInteractionMode === previousServerInteractionMode
  );
}

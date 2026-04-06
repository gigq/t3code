import type { ProviderInteractionMode } from "@t3tools/contracts";

export function shouldResetInteractionModeDraftOverride(input: {
  draftInteractionMode: ProviderInteractionMode | null | undefined;
  previousServerInteractionMode: ProviderInteractionMode | null | undefined;
  nextServerInteractionMode: ProviderInteractionMode | null | undefined;
}): boolean {
  const draftInteractionMode = input.draftInteractionMode ?? null;
  const previousServerInteractionMode = input.previousServerInteractionMode ?? null;
  const nextServerInteractionMode = input.nextServerInteractionMode ?? null;

  if (draftInteractionMode === null || nextServerInteractionMode === null) {
    return false;
  }

  // On a fresh page load there is no previous server value yet. In that case,
  // any persisted draft override that disagrees with the server snapshot is stale.
  if (previousServerInteractionMode === null) {
    return draftInteractionMode !== nextServerInteractionMode;
  }

  return (
    previousServerInteractionMode !== nextServerInteractionMode &&
    draftInteractionMode === previousServerInteractionMode
  );
}

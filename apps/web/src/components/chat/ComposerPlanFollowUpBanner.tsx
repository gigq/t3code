import { memo } from "react";
import { XIcon } from "lucide-react";

import { Button } from "../ui/button";

export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
  onDismiss,
  dismissing,
}: {
  planTitle: string | null;
  onDismiss: () => void;
  dismissing?: boolean;
}) {
  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">Plan ready</span>
        {planTitle ? (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{planTitle}</span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground/60 hover:text-foreground/80"
          aria-label="Close out plan"
          title="Close out plan"
          onClick={onDismiss}
          disabled={dismissing}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      {/* <div className="mt-2 text-xs text-muted-foreground">
        Review the plan
      </div> */}
    </div>
  );
});

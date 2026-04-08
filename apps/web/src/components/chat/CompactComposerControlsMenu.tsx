import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { isAutoModeDeferred, type AutoModeDeferPreset } from "@t3tools/shared/autoMode";
import { memo, type ReactNode } from "react";
import { Clock3Icon, EllipsisIcon, ListTodoIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode: ProviderInteractionMode;
  autoDeferUntil?: string | null;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  traitsMenuContent?: ReactNode;
  onSelectInteractionMode: (mode: ProviderInteractionMode) => void;
  onSetAutoDeferUntil?: (value: AutoModeDeferPreset | null) => void;
  onTogglePlanSidebar: () => void;
  onToggleRuntimeMode: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
        <MenuRadioGroup
          value={props.interactionMode}
          onValueChange={(value) => {
            if (!value || value === props.interactionMode) return;
            props.onSelectInteractionMode(value as ProviderInteractionMode);
          }}
        >
          <MenuRadioItem value="default">Chat</MenuRadioItem>
          <MenuRadioItem value="auto">Auto</MenuRadioItem>
          <MenuRadioItem value="plan">Plan</MenuRadioItem>
        </MenuRadioGroup>
        {props.interactionMode === "auto" && props.onSetAutoDeferUntil ? (
          <>
            <MenuDivider />
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Wait</div>
            <MenuItem onClick={() => props.onSetAutoDeferUntil?.("15m")}>
              <Clock3Icon className="size-4 shrink-0" />
              Defer 15m
            </MenuItem>
            <MenuItem onClick={() => props.onSetAutoDeferUntil?.("1h")}>
              <Clock3Icon className="size-4 shrink-0" />
              Defer 1h
            </MenuItem>
            <MenuItem onClick={() => props.onSetAutoDeferUntil?.("tomorrow-8am")}>
              <Clock3Icon className="size-4 shrink-0" />
              Defer until tomorrow 8am
            </MenuItem>
            {isAutoModeDeferred(props.autoDeferUntil) ? (
              <MenuItem onClick={() => props.onSetAutoDeferUntil?.(null)}>
                <Clock3Icon className="size-4 shrink-0" />
                Resume auto now
              </MenuItem>
            ) : null}
          </>
        ) : null}
        <MenuDivider />
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            props.onToggleRuntimeMode();
          }}
        >
          <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
          <MenuRadioItem value="full-access">Full access</MenuRadioItem>
        </MenuRadioGroup>
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});

"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { cn } from "@/app/lib/utils";
import { Input, type InputProps } from "@/components/ui/input";

export interface MaskedInputProps extends Omit<InputProps, "type"> {
  revealLabel?: string;
  hideLabel?: string;
}

const MaskedInput = React.forwardRef<HTMLInputElement, MaskedInputProps>(
  (
    {
      className,
      revealLabel = "Show value",
      hideLabel = "Hide value",
      ...props
    },
    ref,
  ) => {
    const [visible, setVisible] = React.useState(false);

    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? "text" : "password"}
          className={cn("pr-10", className)}
          {...props}
        />
        <button
          type="button"
          aria-label={visible ? hideLabel : revealLabel}
          onClick={() => setVisible((value) => !value)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    );
  },
);
MaskedInput.displayName = "MaskedInput";

export { MaskedInput };

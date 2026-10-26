import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        "flex h-10 w-full rounded-md border border-canal bg-paper px-3 py-2 text-sm text-ardoise ring-offset-white placeholder:text-ardoise/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-encre",
        className
      )}
      ref={ref}
      {...props}
    />
  )
);
Input.displayName = "Input";

export { Input };

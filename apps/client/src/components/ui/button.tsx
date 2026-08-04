import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

// THE button: one implementation, variants not forks — `ai` is for AI touchpoints only.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-sm font-medium cursor-pointer transition-all duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-[var(--orchestr-accent-tint-strong)]",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--orchestr-action)] text-[var(--orchestr-surface)] font-semibold hover:bg-[var(--orchestr-action-hover)]",
        secondary:
          "bg-[var(--orchestr-surface-raised)] text-[var(--orchestr-ink)] border border-[var(--orchestr-line)] hover:border-[var(--orchestr-line-strong)]",
        ghost:
          "bg-transparent text-[var(--orchestr-ink-muted)] hover:bg-[var(--orchestr-accent-tint)] hover:text-[var(--orchestr-ink)]",
        destructive:
          "bg-[var(--orchestr-danger-tint)] text-[var(--orchestr-danger)] hover:bg-[color-mix(in_srgb,var(--orchestr-danger)_18%,transparent)]",
        success:
          "bg-[var(--orchestr-success-tint)] text-[var(--orchestr-success)] hover:bg-[color-mix(in_srgb,var(--orchestr-success)_18%,transparent)]",
        destructiveSolid: "bg-[var(--orchestr-danger)] text-[var(--orchestr-surface)] font-semibold hover:opacity-90",
        ai: "bg-[var(--orchestr-ai)] text-white hover:bg-[var(--orchestr-ai-bright)]",
        link: "bg-transparent text-[var(--orchestr-ink)] underline-offset-4 hover:underline p-0 h-auto",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-lg px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 rounded-lg gap-1.5 px-3 text-xs has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };

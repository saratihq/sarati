"use client";

import { createElement, memo, type CSSProperties } from "react";
import {
  Bot,
  Braces,
  Calculator,
  Calendar,
  Clock,
  Code,
  FileText,
  GitBranch,
  Globe,
  Hourglass,
  KeyRound,
  Mail,
  MessageCircle,
  Network,
  QrCode,
  Repeat,
  Rss,
  Server,
  Shuffle,
  Split,
  Table,
  Type,
  Webhook,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useNodeIcons } from "@/store/useNodeIcons";

interface NodeIconProps {
  nodeType: string;
  size?: number;
  className?: string;
}

// Control + utility nodes carry no app logo — a lucide glyph matching the
// node's job stands in.
const CONTROL_ICONS: Record<string, LucideIcon> = {
  "orchestr:if": GitBranch,
  "orchestr:loop": Repeat,
  "orchestr:switch": Split,
  "orchestr:code": Code,
  "orchestr:wait_for_event": Hourglass,
  "orchestr:agent": Bot,
  "orchestr:call_workflow": Workflow,
  "orchestr:trigger": Zap,
  "orchestr:webhook": Webhook,
  "orchestr:schedule": Clock,
  "orchestr:chat": MessageCircle,
};
// Utility apps (first-party helper actions, keyed by the `<slug>` of `<slug>.<action>`).
const UTILITY_ICONS: Record<string, LucideIcon> = {
  http: Globe,
  text: Type,
  date: Calendar,
  json: Braces,
  csv: Table,
  math: Calculator,
  pdf: FileText,
  qrcode: QrCode,
  xml: Code,
  rss: Rss,
  smtp: Mail,
  sftp: Server,
  "data-mapper": Shuffle,
  crypto: KeyRound,
  graphql: Network,
};

function lucideFor(nodeType: string): LucideIcon | null {
  if (CONTROL_ICONS[nodeType]) return CONTROL_ICONS[nodeType];
  const dot = nodeType.indexOf(".");
  const slug = dot > 0 ? nodeType.slice(0, dot) : nodeType;
  return UTILITY_ICONS[slug] ?? null;
}

/** Which surface a node icon uses — a bare lucide `"glyph"` (wants a chip) or a self-filling `"tile"`. */
export function nodeIconKind(nodeType: string): "glyph" | "tile" {
  return lucideFor(nodeType) ? "glyph" : "tile";
}

// Monogram floor for apps with neither a logo nor a glyph: two initials for a
// hyphen/underscore slug (`power-bi` → PB), one otherwise (`slack` → S).
function monogram(nodeType: string): string {
  const dot = nodeType.indexOf(".");
  const slug = (dot > 0 ? nodeType.slice(0, dot) : nodeType).replace(/^orchestr:/, "");
  const parts = slug.split(/[-_]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return (slug.slice(0, 1) || "?").toUpperCase();
}

const centered = (size: number): CSSProperties => ({
  width: size,
  height: size,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  overflow: "hidden",
});

// App logos sit on a near-white tile so their own colours — and black marks
// like GitHub/Notion — stay legible on the dark canvas.
const tile = (size: number): CSSProperties => ({
  ...centered(size),
  background: "#ffffff",
  borderRadius: Math.max(4, Math.round(size * 0.32)),
  boxShadow: "inset 0 0 0 1px rgba(0, 0, 0, 0.06)",
});
// The logo fills ~80% of the tile so full-bleed marks don't clip on the corners.
const LOGO_FILL = 0.8;
const inner = (size: number): CSSProperties => ({
  width: Math.round(size * LOGO_FILL),
  height: Math.round(size * LOGO_FILL),
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
});

// Stable per-app accent so an unmapped app reads as a deliberate avatar.
const MONO_COLORS = ["#4f46e5", "#0891b2", "#059669", "#d97706", "#dc2626", "#7c3aed", "#db2777", "#0d9488"];
function monoColor(nodeType: string): string {
  let h = 0;
  for (let i = 0; i < nodeType.length; i++) h = (h * 31 + nodeType.charCodeAt(i)) >>> 0;
  return MONO_COLORS[h % MONO_COLORS.length]!;
}

function NodeIconComponent({ nodeType, size = 20, className = "" }: NodeIconProps) {
  const svg = useNodeIcons((s) => s.icons[nodeType]);

  // 1) A brand app logo from the service — inline SVG markup or a data: URI.
  if (svg) {
    if (svg.startsWith("data:")) {
      return (
        <span className={`node-icon ${className}`} style={tile(size)}>
          {/* next/image cannot optimize a data: URI SVG; a plain <img> is correct here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={svg}
            width={Math.round(size * LOGO_FILL)}
            height={Math.round(size * LOGO_FILL)}
            alt=""
            style={{ display: "block", objectFit: "contain" }}
          />
        </span>
      );
    }
    return (
      <span className={`node-icon ${className}`} style={tile(size)}>
        <span style={inner(size)} dangerouslySetInnerHTML={{ __html: svg }} />
      </span>
    );
  }

  // 2) Control / utility node → a meaningful lucide glyph.
  const icon = lucideFor(nodeType);
  if (icon) {
    return (
      <span className={`node-icon ${className}`} style={centered(size)}>
        {createElement(icon, {
          size: Math.round(size * 0.82),
          strokeWidth: 1.75,
          color: "var(--orchestr-ink-muted)",
        })}
      </span>
    );
  }

  // 3) Monogram floor — initials on the same tile, never a blank box.
  const mono = monogram(nodeType);
  return (
    <span
      className={`node-icon ${className}`}
      style={{
        ...tile(size),
        color: monoColor(nodeType),
        fontSize: Math.round(size * (mono.length > 1 ? 0.4 : 0.5)),
        fontWeight: 700,
        lineHeight: 1,
        letterSpacing: mono.length > 1 ? "-0.03em" : "0",
      }}
      aria-hidden="true"
    >
      {mono}
    </span>
  );
}

export default memo(NodeIconComponent);

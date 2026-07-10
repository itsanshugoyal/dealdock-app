import type { ClassificationLabel } from "@dealdock/core";

const LABEL_META: Record<
  ClassificationLabel,
  { text: string; color: string; bg: string; border: string }
> = {
  brand_deal: { text: "Brand Deal", color: "#22c55e", bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.25)" },
  coaching_lead: { text: "Coaching", color: "#3b82f6", bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.25)" },
  course_inquiry: { text: "Course", color: "#a855f7", bg: "rgba(168,85,247,0.10)", border: "rgba(168,85,247,0.25)" },
  other_commerce: { text: "Commerce", color: "#f97316", bg: "rgba(249,115,22,0.10)", border: "rgba(249,115,22,0.25)" },
  fan: { text: "Fan", color: "#737373", bg: "rgba(115,115,115,0.10)", border: "rgba(115,115,115,0.25)" },
  spam: { text: "Spam", color: "#525252", bg: "rgba(82,82,82,0.10)", border: "rgba(82,82,82,0.25)" },
  personal: { text: "Personal", color: "#737373", bg: "rgba(115,115,115,0.10)", border: "rgba(115,115,115,0.25)" },
  uncertain: { text: "Uncertain", color: "#eab308", bg: "rgba(234,179,8,0.10)", border: "rgba(234,179,8,0.25)" },
};

/** Color is never the only signal — the label text is always present (DESIGN.md §7). */
export function Badge({ label }: { label: ClassificationLabel }) {
  const meta = LABEL_META[label];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none"
      style={{ color: meta.color, backgroundColor: meta.bg, border: `1px solid ${meta.border}` }}
    >
      {meta.text}
    </span>
  );
}

export function labelText(label: ClassificationLabel): string {
  return LABEL_META[label].text;
}

"use client";

import { Suspense, use } from "react";
import { Conversation } from "../../../../components/conversation";

/** Unknown ids still render 200; the conversation shows its own "not available" state. */
export default function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={null}>
      <Conversation id={decodeURIComponent(id)} />
    </Suspense>
  );
}

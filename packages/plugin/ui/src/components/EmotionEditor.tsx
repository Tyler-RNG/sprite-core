import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { putEmotion } from "../api/client.js";
import type { EmotionDirective, EmotionEntry } from "../api/types.js";
import { EmotionFields, emotionDirectiveHasAny } from "./EmotionFields.js";

type Props = {
  agentId: string;
  stateName: string;
  initial: EmotionEntry;
};

/**
 * Edit one per-state emotion entry. Writes back to:
 *   PUT /sprite-core/agents/:agentId/emotions/:state
 *
 * Kept intentionally narrow — one state at a time — so the PUT is tiny and
 * the plugin's read-modify-write stays scoped to a single config branch.
 *
 * Today this is the fallback for non-`sprites` avatar kinds (states / atlas).
 * The `sprites` kind uses AnimationCard, which embeds EmotionFields directly.
 */
export function EmotionEditor({ agentId, stateName, initial }: Props): JSX.Element {
  const qc = useQueryClient();
  const [description, setDescription] = useState(initial.description);
  const [directive, setDirective] = useState<EmotionDirective>(initial.directive ?? {});

  useEffect(() => {
    setDescription(initial.description);
    setDirective(initial.directive ?? {});
  }, [agentId, stateName, initial]);

  const save = useMutation({
    mutationFn: async () => {
      const entry: EmotionEntry = {
        description,
        ...(emotionDirectiveHasAny(directive) ? { directive } : {}),
      };
      await putEmotion(agentId, stateName, entry);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  const dirty =
    description !== initial.description ||
    JSON.stringify(directive) !== JSON.stringify(initial.directive ?? {});

  return (
    <div className="card">
      <h3>emotions.{stateName}</h3>
      <EmotionFields
        description={description}
        directive={directive}
        onDescriptionChange={setDescription}
        onDirectiveChange={setDirective}
      />
      <div className="toolbar">
        {save.isError && <span className="status error">{String(save.error)}</span>}
        {save.isSuccess && !dirty && <span className="status ok">saved</span>}
        <button
          className="primary"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "saving…" : "save"}
        </button>
      </div>
    </div>
  );
}

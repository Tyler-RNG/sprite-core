import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { putEmotion } from "../api/client.js";
import type { EmotionDirective, EmotionEntry } from "../api/types.js";

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
        ...(hasAny(directive) ? { directive } : {}),
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
      <h3>
        emotions.{stateName}
      </h3>
      <div className="field">
        <label>description</label>
        <textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Prompt-visible description of this emotion."
        />
      </div>
      <div className="field-row">
        <div className="field">
          <label>voiceId (override)</label>
          <input
            value={directive.voiceId ?? ""}
            onChange={(e) => updateDirective(setDirective, "voiceId", e.target.value || undefined)}
          />
        </div>
        <div className="field">
          <label>audioTag</label>
          <input
            value={directive.audioTag ?? ""}
            placeholder="[happy]"
            onChange={(e) => updateDirective(setDirective, "audioTag", e.target.value || undefined)}
          />
        </div>
      </div>
      <div className="field-row">
        <NumberField
          label="stability (0–1)"
          value={directive.stability}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => updateDirective(setDirective, "stability", v)}
        />
        <NumberField
          label="similarity (0–1)"
          value={directive.similarity}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => updateDirective(setDirective, "similarity", v)}
        />
        <NumberField
          label="style (0–1)"
          value={directive.style}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => updateDirective(setDirective, "style", v)}
        />
        <NumberField
          label="speed (0.25–4)"
          value={directive.speed}
          min={0.25}
          max={4}
          step={0.05}
          onChange={(v) => updateDirective(setDirective, "speed", v)}
        />
      </div>
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

function hasAny(d: EmotionDirective): boolean {
  return Object.values(d).some((v) => v !== undefined && v !== "");
}

function updateDirective<K extends keyof EmotionDirective>(
  setter: (fn: (d: EmotionDirective) => EmotionDirective) => void,
  key: K,
  value: EmotionDirective[K] | undefined,
): void {
  setter((d) => {
    const next = { ...d };
    if (value === undefined || value === "") {
      delete next[key];
    } else {
      next[key] = value;
    }
    return next;
  });
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  step: number;
  onChange: (v: number | undefined) => void;
}): JSX.Element {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="number"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(undefined);
            return;
          }
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : undefined);
        }}
      />
    </div>
  );
}

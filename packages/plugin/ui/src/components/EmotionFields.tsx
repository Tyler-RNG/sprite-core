import type { EmotionDirective } from "../api/types.js";

type Props = {
  description: string;
  directive: EmotionDirective;
  onDescriptionChange: (next: string) => void;
  onDirectiveChange: (next: EmotionDirective) => void;
  /** Optional: render the description as a 1-click "rig" prefill. */
  onPrefillDescription?: (() => void) | null;
};

/**
 * Form fields for a single state's emotion: description (prompt-visible) and
 * the optional `EmotionDirective` (TTS overrides). Pure controlled component;
 * dirty tracking and persistence live in the consumer (EmotionEditor or
 * AnimationCard).
 */
export function EmotionFields({
  description,
  directive,
  onDescriptionChange,
  onDirectiveChange,
  onPrefillDescription,
}: Props): JSX.Element {
  const setKey = <K extends keyof EmotionDirective>(
    key: K,
    value: EmotionDirective[K] | undefined,
  ): void => {
    const next = { ...directive };
    if (value === undefined || value === "") {
      delete next[key];
    } else {
      next[key] = value;
    }
    onDirectiveChange(next);
  };

  return (
    <>
      <div className="field">
        <div className="field-header">
          <label>description</label>
          {onPrefillDescription && (
            <button
              type="button"
              className="link-btn"
              onClick={onPrefillDescription}
            >
              fill from prompting.descriptions
            </button>
          )}
        </div>
        <textarea
          rows={2}
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="Prompt-visible description of this emotion."
        />
      </div>
      <div className="field-row">
        <div className="field">
          <label>voiceId (override)</label>
          <input
            value={directive.voiceId ?? ""}
            onChange={(e) => setKey("voiceId", e.target.value || undefined)}
          />
        </div>
        <div className="field">
          <label>audioTag</label>
          <input
            value={directive.audioTag ?? ""}
            placeholder="[happy]"
            onChange={(e) => setKey("audioTag", e.target.value || undefined)}
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
          onChange={(v) => setKey("stability", v)}
        />
        <NumberField
          label="similarity (0–1)"
          value={directive.similarity}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => setKey("similarity", v)}
        />
        <NumberField
          label="style (0–1)"
          value={directive.style}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => setKey("style", v)}
        />
        <NumberField
          label="speed (0.25–4)"
          value={directive.speed}
          min={0.25}
          max={4}
          step={0.05}
          onChange={(v) => setKey("speed", v)}
        />
      </div>
    </>
  );
}

export function emotionDirectiveHasAny(d: EmotionDirective): boolean {
  return Object.values(d).some((v) => v !== undefined && v !== "");
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

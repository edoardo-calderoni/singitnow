import { useState } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";

/** Campo password con l'occhio per mostrarla o nasconderla. */
export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete = "current-password",
  autoFocus,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoComplete?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="field">
      <Lock size={18} />
      <input
        type={shown ? "text" : "password"}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
        autoFocus={autoFocus}
      />
      <button
        type="button"
        className="pw-eye"
        title={shown ? "Nascondi password" : "Mostra password"}
        aria-label={shown ? "Nascondi password" : "Mostra password"}
        aria-pressed={shown}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}

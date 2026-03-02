import { Check, X, Info } from '@phosphor-icons/react';
import type { Toast } from '../../hooks/useToast';
import './Toast.css';

interface ToastListProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

const ICONS: Record<string, React.ReactNode> = {
  success: <Check size={14} weight="bold" />,
  error:   <X     size={14} weight="bold" />,
  info:    <Info  size={14} />,
};

export default function ToastList({ toasts, onDismiss }: ToastListProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.type}${t.exiting ? ' toast--exit' : ''}`}
          role="alert"
          onClick={() => onDismiss(t.id)}
        >
          <span className="toast-icon">{ICONS[t.type]}</span>
          <span className="toast-msg">{t.message}</span>
          {/* Botão X explícito para erros (toque mais preciso) */}
          {t.type === 'error' && (
            <button
              className="toast-close"
              onClick={(e) => { e.stopPropagation(); onDismiss(t.id); }}
              aria-label="Fechar"
            ><X size={14} weight="bold" /></button>
          )}
        </div>
      ))}
    </div>
  );
}

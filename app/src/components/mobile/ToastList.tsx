import type { Toast } from '../../hooks/useToast';
import './Toast.css';

interface ToastListProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

const ICONS: Record<string, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
};

export default function ToastList({ toasts, onDismiss }: ToastListProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.type}`}
          role="alert"
          onClick={() => onDismiss(t.id)}
        >
          <span className="toast-icon">{ICONS[t.type]}</span>
          <span className="toast-msg">{t.message}</span>
        </div>
      ))}
    </div>
  );
}

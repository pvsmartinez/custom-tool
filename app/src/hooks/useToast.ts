import { useState, useCallback, useRef } from 'react';

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  exiting?: boolean;
}

type ShowToastOptions = {
  message: string;
  type?: ToastType;
  /** Milissegundos até auto-dismiss. Use null para não auto-dispensar. */
  duration?: number | null;
};

let counter = 0;
const EXIT_DURATION = 250; // deve bater com a animation de saída no CSS

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    timers.current.delete(id);
  }, []);

  const dismiss = useCallback((id: number) => {
    // Marca como "saindo" para jogar a animação de saída
    setToasts((prev) => prev.map((t) => t.id === id ? { ...t, exiting: true } : t));
    // Cancela timer anterior se existir
    const existing = timers.current.get(id);
    if (existing) { clearTimeout(existing); timers.current.delete(id); }
    // Remove após a animação
    const exit = setTimeout(() => remove(id), EXIT_DURATION);
    timers.current.set(id, exit);
  }, [remove]);

  const toast = useCallback(
    ({ message, type = 'info', duration = 4000 }: ShowToastOptions) => {
      const id = ++counter;
      setToasts((prev) => [...prev, { id, message, type }]);
      if (duration !== null) {
        const timer = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  return { toasts, toast, dismiss };
}

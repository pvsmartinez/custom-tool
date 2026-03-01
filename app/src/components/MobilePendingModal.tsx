import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { MobilePendingTask } from '../services/mobilePendingTasks';
import { deletePendingTask } from '../services/mobilePendingTasks';
import './MobilePendingModal.css';

interface MobilePendingModalProps {
  open: boolean;
  workspacePath: string;
  tasks: MobilePendingTask[];
  /** Called when the user clicks "Execute" on a task — sends its description to the AI panel. */
  onExecute: (task: MobilePendingTask) => void;
  /** Called when all tasks are dismissed/deleted and the modal should close. */
  onClose: () => void;
  /** Called after a task is deleted so the parent can refresh the list. */
  onTaskDeleted: (id: string) => void;
}

export default function MobilePendingModal({
  open,
  workspacePath,
  tasks,
  onExecute,
  onClose,
  onTaskDeleted,
}: MobilePendingModalProps) {
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  if (!open || tasks.length === 0) return null;

  async function handleDelete(id: string) {
    setDeleting(prev => new Set(prev).add(id));
    try {
      await deletePendingTask(workspacePath, id);
      onTaskDeleted(id);
    } finally {
      setDeleting(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  }

  function handleExecute(task: MobilePendingTask) {
    onExecute(task);
    void handleDelete(task.id);
  }

  function formatDate(iso: string) {
    try {
      return new Date(iso).toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  return createPortal(
    <div className="mpm-overlay" onClick={onClose}>
      <div className="mpm-modal" onClick={e => e.stopPropagation()}>
        <div className="mpm-header">
          <span className="mpm-icon">🖥️</span>
          <div>
            <div className="mpm-title">Pendências do celular</div>
            <div className="mpm-subtitle">
              {tasks.length} {tasks.length === 1 ? 'tarefa salva' : 'tarefas salvas'} pelo Copilot no celular
            </div>
          </div>
          <button className="mpm-close" onClick={onClose} title="Fechar">✕</button>
        </div>

        <div className="mpm-list">
          {tasks.map(task => (
            <div key={task.id} className="mpm-task">
              <div className="mpm-task-body">
                <div className="mpm-task-desc">{task.description}</div>
                {task.context && (
                  <pre className="mpm-task-ctx">{task.context}</pre>
                )}
                <div className="mpm-task-date">{formatDate(task.createdAt)}</div>
              </div>
              <div className="mpm-task-actions">
                <button
                  className="mpm-btn mpm-btn-primary"
                  onClick={() => handleExecute(task)}
                  disabled={deleting.has(task.id)}
                  title="Enviar para o Copilot e remover da fila"
                >
                  ▶ Executar
                </button>
                <button
                  className="mpm-btn mpm-btn-ghost"
                  onClick={() => void handleDelete(task.id)}
                  disabled={deleting.has(task.id)}
                  title="Descartar sem executar"
                >
                  Descartar
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="mpm-footer">
          <button className="mpm-btn mpm-btn-ghost" onClick={onClose}>
            Fechar — executar depois
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

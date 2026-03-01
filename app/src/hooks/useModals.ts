import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export type SettingsTab = 'general' | 'workspace' | 'sync';

export interface UseModalsReturn {
  // Update modal
  showUpdateModal: boolean;
  setShowUpdateModal: Dispatch<SetStateAction<boolean>>;
  // Settings modal
  showSettings: boolean;
  settingsInitialTab: SettingsTab;
  openSettings: (tab?: SettingsTab) => void;
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  // Image search panel
  imgSearchOpen: boolean;
  setImgSearchOpen: Dispatch<SetStateAction<boolean>>;
  // Export modal
  exportModalOpen: boolean;
  setExportModalOpen: Dispatch<SetStateAction<boolean>>;
  // Find+Replace bar
  findReplaceOpen: boolean;
  setFindReplaceOpen: Dispatch<SetStateAction<boolean>>;
  // AI panel
  aiOpen: boolean;
  setAiOpen: Dispatch<SetStateAction<boolean>>;
  aiInitialPrompt: string;
  setAiInitialPrompt: Dispatch<SetStateAction<string>>;
}

/**
 * Centralises all modal / overlay open-state so App.tsx doesn't manage
 * a dozen individual useState calls for visibility flags.
 */
export function useModals(): UseModalsReturn {
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('general');
  const [imgSearchOpen, setImgSearchOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInitialPrompt, setAiInitialPrompt] = useState('');

  function openSettings(tab: SettingsTab = 'general') {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }

  return {
    showUpdateModal, setShowUpdateModal,
    showSettings, setShowSettings,
    settingsInitialTab,
    openSettings,
    imgSearchOpen, setImgSearchOpen,
    exportModalOpen, setExportModalOpen,
    findReplaceOpen, setFindReplaceOpen,
    aiOpen, setAiOpen,
    aiInitialPrompt, setAiInitialPrompt,
  };
}

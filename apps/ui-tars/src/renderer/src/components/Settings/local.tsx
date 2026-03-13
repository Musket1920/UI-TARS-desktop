import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Button } from '@renderer/components/ui/button';
import { VLMConnectionMode } from '@main/store/types';
import { LocalStore } from '@main/store/validate';

import { VLMSettings, VLMSettingsRef } from './category/vlm';
import { useRef, useState } from 'react';

interface LocalSettingsDialogProps {
  isOpen: boolean;
  onSubmit: () => void;
  onClose: () => void;
}

export const checkVLMSettings = async () => {
  const settingRpc = window.electron.setting;

  const currentSetting = ((await settingRpc.getSetting()) ||
    {}) as Partial<LocalStore>;
  const {
    vlmConnectionMode,
    vlmApiKey,
    vlmBaseUrl,
    vlmModelName,
    vlmProvider,
  } = currentSetting;

  if (!vlmBaseUrl || !vlmModelName || !vlmProvider) {
    return false;
  }

  if (
    (vlmConnectionMode ?? VLMConnectionMode.Managed) ===
    VLMConnectionMode.LocalhostOpenAICompatible
  ) {
    return false;
  }

  return Boolean(vlmApiKey);
};

export const LocalSettingsDialog = ({
  isOpen,
  onSubmit,
  onClose,
}: LocalSettingsDialogProps) => {
  const vlmSettingsRef = useRef<VLMSettingsRef>(null);
  const [canStart, setCanStart] = useState(false);

  const handleGetStart = async () => {
    try {
      await vlmSettingsRef.current?.submit();
      onSubmit();
    } catch (error) {
      console.error('Failed to submit settings:', error);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[480]">
        <DialogHeader>
          <DialogTitle>VLM Settings</DialogTitle>
          <DialogDescription>
            Enter VLM settings to enable the model to control the local computer
            or browser.
          </DialogDescription>
        </DialogHeader>
        <VLMSettings
          ref={vlmSettingsRef}
          onSubmitAvailabilityChange={setCanStart}
        />
        <Button className="mt-8 mx-8" onClick={handleGetStart} disabled={!canStart}>
          Get Start
        </Button>
      </DialogContent>
    </Dialog>
  );
};

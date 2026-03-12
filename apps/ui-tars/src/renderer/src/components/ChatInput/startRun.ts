export type RunRequestPhase = 'idle' | 'submitting';

type ExecuteChatInputRunOptions = {
  checkBeforeRun?: () => Promise<boolean>;
  setRunRequestPhase: (phase: RunRequestPhase) => void;
  onRun: () => Promise<void>;
  onError: (message: string) => void;
};

export const getChatInputRunErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return 'Failed to start run';
};

export const executeChatInputRun = async ({
  checkBeforeRun,
  setRunRequestPhase,
  onRun,
  onError,
}: ExecuteChatInputRunOptions) => {
  try {
    setRunRequestPhase('submitting');

    if (checkBeforeRun) {
      const checked = await checkBeforeRun();

      if (!checked) {
        return;
      }
    }

    await onRun();
  } catch (error) {
    onError(getChatInputRunErrorMessage(error));
  } finally {
    setRunRequestPhase('idle');
  }
};

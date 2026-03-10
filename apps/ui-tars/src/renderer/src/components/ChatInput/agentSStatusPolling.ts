export type AgentSStatusSnapshot<THealth, TRuntimeStatus> = {
  health: THealth | null;
  runtimeStatus: TRuntimeStatus | null;
};

type CreateAgentSStatusPollerOptions<THealth, TRuntimeStatus> = {
  isSelected: () => boolean;
  setLoadingStatus: (loading: boolean) => void;
  setStatus: (status: AgentSStatusSnapshot<THealth, TRuntimeStatus>) => void;
  fetchStatus: () => Promise<{
    health: THealth;
    runtimeStatus: TRuntimeStatus;
  }>;
  onPollError?: (error: unknown) => void;
};

export const createAgentSStatusPoller = <THealth, TRuntimeStatus>({
  isSelected,
  setLoadingStatus,
  setStatus,
  fetchStatus,
  onPollError,
}: CreateAgentSStatusPollerOptions<THealth, TRuntimeStatus>) => {
  let active = true;

  const poll = async () => {
    if (!isSelected()) {
      if (!active) {
        return;
      }

      setLoadingStatus(false);
      setStatus({ health: null, runtimeStatus: null });
      return;
    }

    if (!active) {
      return;
    }

    setLoadingStatus(true);

    try {
      const nextStatus = await fetchStatus();

      if (!active) {
        return;
      }

      setStatus(nextStatus);
    } catch (error) {
      if (!active) {
        return;
      }

      onPollError?.(error);
      setStatus({ health: null, runtimeStatus: null });
    } finally {
      setLoadingStatus(false);
    }
  };

  return {
    poll,
    stop: () => {
      active = false;
    },
  };
};

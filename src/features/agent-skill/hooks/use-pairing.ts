import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import {
  cancelPairingCode,
  generatePairingCode,
  pairingStatusQuery,
} from "@/features/agent-skill/queries";
import { API_KEYS_QUERY_KEY } from "@/features/api-keys/hooks/use-api-keys";
import { m } from "@/paraglide/messages";

export function usePairing() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery(pairingStatusQuery);
  const status = statusQuery.data;
  const connectedKeyId =
    status?.state === "connected" ? status.agent?.apiKeyId : undefined;

  // The paired agent's key is new to the key list.
  useEffect(() => {
    if (connectedKeyId) {
      void queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
    }
  }, [connectedKeyId, queryClient]);

  const refreshStatus = () =>
    queryClient.invalidateQueries({ queryKey: pairingStatusQuery.queryKey });

  const generateMutation = useMutation({
    mutationFn: generatePairingCode,
    onSuccess: refreshStatus,
    onError: () => {
      toast.error(m.agent_skill_pair_generate_failed());
    },
  });

  const cancelMutation = useMutation({
    mutationFn: cancelPairingCode,
    onSuccess: refreshStatus,
    onError: () => {
      toast.error(m.agent_skill_pair_cancel_failed());
    },
  });

  return {
    status,
    isLoading: statusQuery.isPending,
    isError: statusQuery.isError && status === undefined,
    reload: statusQuery.refetch,
    generate: generateMutation.mutateAsync,
    isGenerating: generateMutation.isPending,
    cancel: cancelMutation.mutateAsync,
    isCancelling: cancelMutation.isPending,
  };
}

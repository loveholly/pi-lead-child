import type { ControlPlaneStoreState } from './control-plane/store';

export const EMPTY_IDS: readonly never[] = [];

export const selectPhase = (state: ControlPlaneStoreState) => state.phase;
export const selectTicketIds = (state: ControlPlaneStoreState) => state.ticketIds;
export const selectProjectIds = (state: ControlPlaneStoreState) => state.projectIds;
export const selectAgendaIds = (state: ControlPlaneStoreState) => state.agendaIds;
export const selectApprovalIds = (state: ControlPlaneStoreState) => state.approvalIds;
export const selectTicket = (ticketId: number) => (state: ControlPlaneStoreState) => state.ticketsById[ticketId];
export const selectWorkItemIds = (state: ControlPlaneStoreState) => state.workItemIds;
export const selectConversationCardIds = (state: ControlPlaneStoreState) => state.conversationCardIds;
export const selectWorkItem = (ticketId: number) =>
  (state: ControlPlaneStoreState) => state.workItemsById[ticketId];
export const selectTicketTiming = (ticketId: number) =>
  (state: ControlPlaneStoreState) => state.ticketTimingsById[ticketId];
export const selectTicketWorkbench = (ticketId: number) =>
  (state: ControlPlaneStoreState) => state.workbenchesById[ticketId];
export const selectConversationCard = (cardKey: string) =>
  (state: ControlPlaneStoreState) => state.conversationCardsById[cardKey];
export const selectIntervention = (interventionId: string) =>
  (state: ControlPlaneStoreState) => state.interventionsById[interventionId]
    ?? state.interventionRefsById[interventionId];

export const selectInterventionsForTicket = (ticketId: number) => {
  let previousIds: readonly string[] = EMPTY_IDS;
  let result: (
    ControlPlaneStoreState['interventionsById'][string] |
    ControlPlaneStoreState['interventionRefsById'][string]
  )[] = [];
  return (state: ControlPlaneStoreState) => {
    const ids = state.interventionIdsByTicket[ticketId] ?? EMPTY_IDS;
    const next = ids.flatMap((id) => {
      const intervention = state.interventionsById[id] ?? state.interventionRefsById[id];
      return intervention ? [intervention] : [];
    });
    if (idsEqual(ids, previousIds) && referencesEqual(next, result)) return result;
    previousIds = ids;
    result = next;
    return result;
  };
};

export const selectConversationCardsForTicket = (ticketId?: number) => {
  let previousIds: readonly string[] = EMPTY_IDS;
  let result: ControlPlaneStoreState['conversationCardsById'][string][] = [];
  return (state: ControlPlaneStoreState) => {
    const ids = state.conversationCardIds.filter((id) => {
      const card = state.conversationCardsById[id];
      return card && (ticketId === undefined || card.ticketId === ticketId);
    });
    const next = ids.flatMap((id) => {
      const card = state.conversationCardsById[id];
      return card ? [card] : [];
    });
    if (idsEqual(ids, previousIds) && referencesEqual(next, result)) return result;
    previousIds = ids;
    result = next;
    return result;
  };
};

export const selectCheckpointIdsNewestFirst = (ticketId: number) => {
  let previous: number[] | undefined;
  let result: number[] = [];
  return (state: ControlPlaneStoreState) => {
    const ids = state.checkpointIdsByTicket[ticketId] ?? EMPTY_IDS;
    if (ids !== previous) {
      previous = ids as number[];
      result = [...ids].reverse();
    }
    return result;
  };
};

function idsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function referencesEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

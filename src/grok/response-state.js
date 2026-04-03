export function buildStoredGrokState({ state, previousGrok = null }) {
  return {
    conversationId:
      state.conversation?.conversationId ?? previousGrok?.conversationId,
    assistantResponseId: state.modelResponse?.responseId,
    userResponseId: state.userResponse?.responseId
  };
}

export function buildStoredGrokState({
  state,
  previousGrok = null,
  accountIndex = previousGrok?.accountIndex
}) {
  return {
    ...(accountIndex === undefined ? {} : { accountIndex }),
    conversationId:
      state.conversation?.conversationId ?? previousGrok?.conversationId,
    assistantResponseId: state.modelResponse?.responseId,
    userResponseId: state.userResponse?.responseId
  };
}

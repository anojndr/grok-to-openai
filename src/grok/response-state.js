export function buildStoredGrokState({
  state,
  previousGrok = null,
  accountIndex = previousGrok?.accountIndex
}) {
  return {
    ...(accountIndex === undefined ? {} : { accountIndex }),
    conversationId:
      state.conversation?.conversationId ?? previousGrok?.conversationId,
    assistantResponseId:
      state.modelResponse?.responseId ??
      state.assistantResponseId ??
      previousGrok?.assistantResponseId,
    userResponseId: state.userResponse?.responseId
  };
}

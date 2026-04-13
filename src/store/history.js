function normalizeInstructionList(instructions = []) {
  const normalized = [];

  for (const instruction of instructions) {
    const trimmed = typeof instruction === "string" ? instruction.trim() : "";
    if (trimmed && !normalized.includes(trimmed)) {
      normalized.push(trimmed);
    }
  }

  return normalized;
}

function normalizeHistoryMessages(messages = []) {
  return Array.isArray(messages) ? messages : [];
}

export function getStoredPreviousResponseId(record) {
  return record?.previous_response_id ?? record?.response?.previous_response_id ?? null;
}

export function mergeHistorySegments(segments) {
  const merged = {
    instructions: [],
    messages: []
  };

  for (const segment of segments) {
    const instructions = normalizeInstructionList(segment?.instructions ?? []);
    for (const instruction of instructions) {
      if (!merged.instructions.includes(instruction)) {
        merged.instructions.push(instruction);
      }
    }

    merged.messages.push(...normalizeHistoryMessages(segment?.messages));
  }

  return merged;
}

export async function materializeResponseHistory(record, loadRecord) {
  const segments = [];
  const seenIds = new Set();
  let current = record;

  while (current) {
    if (current.id) {
      if (seenIds.has(current.id)) {
        throw new Error(`Response history cycle detected for ${current.id}`);
      }

      seenIds.add(current.id);
    }

    segments.push(current.history ?? null);

    if (current.history?.version !== 2) {
      break;
    }

    const previousResponseId = getStoredPreviousResponseId(current);
    if (!previousResponseId) {
      break;
    }

    current = await loadRecord(previousResponseId);
  }

  return mergeHistorySegments(segments.reverse());
}

export async function materializeResponseRecord(record, loadRecord) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    history: await materializeResponseHistory(record, loadRecord)
  };
}

export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export function toOpenAIError(error) {
  if (error instanceof HttpError) {
    const status = error.status;
    let type = "invalid_request_error";
    let code = error.details?.code ?? null;

    if (status === 429) {
      type = "requests";
      code = code ?? "rate_limit_exceeded";
    } else if (status >= 500) {
      type = "server_error";
    }

    return {
      status,
      body: {
        error: {
          message: error.message,
          type,
          param: null,
          code
        }
      }
    };
  }

  return {
    status: 500,
    body: {
      error: {
        message: error instanceof Error ? error.message : "Internal server error",
        type: "server_error",
        param: null,
        code: null
      }
    }
  };
}

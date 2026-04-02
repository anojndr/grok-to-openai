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
    return {
      status: error.status,
      body: {
        error: {
          message: error.message,
          type: "invalid_request_error",
          param: null,
          code: error.details?.code ?? null
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

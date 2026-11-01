export interface HttpErrorMeta {
  code?: string;
  params?: Record<string, unknown>;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public meta?: HttpErrorMeta,
  ) {
    super(message);
  }
}

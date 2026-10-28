/** 结构化错误元数据：code 是前后端契约键（前端按 apiErrors.<code> 翻译），params 供文案插值 */
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

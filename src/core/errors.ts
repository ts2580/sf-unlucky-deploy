export type SfudErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_SOURCE'
  | 'FILESYSTEM_ERROR'
  | 'SF_COMMAND_FAILED'
  | 'SF_RESPONSE_INVALID'
  | 'SNAPSHOT_FAILED'
  | 'PAYLOAD_CHANGED'
  | 'DEPLOY_FAILED';

export class SfudError extends Error {
  public readonly code: SfudErrorCode;

  public constructor(code: SfudErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SfudError';
    this.code = code;
  }
}

export class SetupStepError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'SetupStepError';
    this.exitCode = exitCode;
  }
}

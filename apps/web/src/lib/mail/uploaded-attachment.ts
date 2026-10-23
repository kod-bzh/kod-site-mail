import { createReadStream } from "node:fs";

/** Server-created upload; JSON clients cannot construct this class. */
export class UploadedAttachment {
  constructor(
    readonly filename: string,
    readonly contentType: string,
    readonly size: number,
    private readonly temporaryPath: string,
  ) {}

  open() { return createReadStream(this.temporaryPath); }
}

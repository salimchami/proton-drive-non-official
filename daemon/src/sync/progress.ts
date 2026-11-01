/** What the sync engine is doing, shown by the UI. Kept free of imports: the UI type-checks it. */
export type Progress =
    /** Full listing of the Drive folder: its size is only known at the end. */
    | { phase: "listing"; folders: number }
    /** Executing one plan; bytes count uploads and downloads only. */
    | {
          phase: "transferring";
          actionsDone: number;
          actionsTotal: number;
          bytesDone: number;
          bytesTotal: number;
          currentPath?: string;
      };

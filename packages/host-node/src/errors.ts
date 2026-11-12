/** The actor crashed. All in-flight work of that activation is gone. */
export class CrashError extends Error {
  readonly actor: string;
  constructor(actor: string) {
    super(`actor ${actor} crashed`);
    this.name = "CrashError";
    this.actor = actor;
  }
}

/** The store refused a write from an activation with a lower owner epoch. */
export class StaleEpochError extends Error {
  readonly have: number;
  readonly stored: number;
  constructor(have: number, stored: number) {
    super(`stale epoch: activation has ${have}, store has ${stored}`);
    this.name = "StaleEpochError";
    this.have = have;
    this.stored = stored;
  }
}

/** A fault hook made `arm` fail. Nothing was armed. */
export class ArmFailedError extends Error {
  constructor(actor: string) {
    super(`arm failed for ${actor} (fault hook)`);
    this.name = "ArmFailedError";
  }
}

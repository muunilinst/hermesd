/**
 * Errors of the model.
 *
 * These are not contract answers. They show a failure of the transport, the
 * process or the VM. A caller that gets one of them does not know if the
 * call had an effect. It must retry with the same op_id.
 */

/** The cell process is down. The call had no effect. */
export class CellDownError extends Error {
  override name = "CellDownError";
}

/** An armed crash point was reached. The cell is now down. */
export class CellCrashedError extends Error {
  override name = "CellCrashedError";
}

/** The VM is not running, so the guest cannot answer. */
export class VmUnavailableError extends Error {
  override name = "VmUnavailableError";
}

/** The caller broke a rule of the contract. Nothing ran. */
export class ProtocolError extends Error {
  override name = "ProtocolError";
}

/** The call had its effect. The reply was dropped. */
export class ReplyLostError extends Error {
  override name = "ReplyLostError";
}

/** The call had its effect. The caller process then crashed. */
export class CallerCrashedError extends Error {
  override name = "CallerCrashedError";
}

/** The message was delayed. The caller timed out. It may arrive later. */
export class MessageDelayedError extends Error {
  override name = "MessageDelayedError";
}

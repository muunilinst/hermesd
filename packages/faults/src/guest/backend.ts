/**
 * The backend of the guest fault tests: the real guest helper logic and a
 * real shim, as child processes on Node, with a process group as the unit.
 *
 * It is NOT a demonstrating backend (it is not in DEMONSTRATING_BACKENDS).
 * The guide counts a pass only with a real executor, a real guest helper and
 * a real TeenyTiny VM. These tests find bugs in the launch logic. They do not
 * change a row of STATUS.md from "Specified" to "Demonstrated".
 */
export const GUEST_PROCESS_BACKEND = "guest-process" as const;

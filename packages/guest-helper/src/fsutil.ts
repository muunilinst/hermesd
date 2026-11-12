import * as fs from "node:fs";
import { dirname, join } from "node:path";

/** Flush a file or a directory to the disk. A directory sync makes new names durable. */
export function fsyncPath(path: string): void {
  const fd = fs.openSync(path, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** `mkdir -p`, and sync the parent of every directory it creates. */
export function mkdirpDurable(dir: string): void {
  if (fs.existsSync(dir)) return;
  mkdirpDurable(dirname(dir));
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  fsyncPath(dir);
  fsyncPath(dirname(dir));
}

/**
 * Create a file with O_CREAT | O_EXCL, write it, sync it and sync its
 * directory. Throws an error with code EEXIST when the file exists.
 * This is the claim primitive.
 */
export function createExclusiveDurable(path: string, data: string): void {
  const fd = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncPath(dirname(path));
}

/** Write a file so that a reader sees all of it or none of it, and make it durable. */
export function writeFileAtomicDurable(path: string, data: string): void {
  const tmp = join(dirname(path), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const fd = fs.openSync(tmp, "w", 0o644);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path);
  fsyncPath(dirname(path));
}

/** Block the thread for `ms` milliseconds. Only the shim uses it. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

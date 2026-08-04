/**
 * V1.46 管理认证轮换跨进程排他锁 —— bootstrap 骨架。
 *
 * 本轮只交付可导入的固定契约面，不交付任何真实锁能力：
 * - 固定相对锁路径与固定超时常量，供后续实现与调用方对齐；
 * - 固定错误类型（name/code/message 三码固定，绝不回显未知输入）；
 * - acquire/release 调用即固定失败，零 fs/spawn/lockf/目录写；
 * - createManagementAuthRotationExclusiveLock 构造本身零 I/O，
 *   返回的 withExclusiveLock(task) 调用即固定失败且绝不调用 task。
 */

/** 跨进程锁文件的固定相对路径（相对数据目录；本轮仅声明，不执行任何路径 I/O）。 */
export const MANAGEMENT_AUTH_ROTATION_PROCESS_LOCK_RELATIVE_PATH =
  'auth/management-rotation.lock';

/** 跨进程锁获取的固定超时秒数（本轮仅声明，不执行任何计时/等待）。 */
export const MANAGEMENT_AUTH_ROTATION_PROCESS_LOCK_TIMEOUT_SECONDS = 5;

/** 进程锁固定错误码：message 与 code 恒等于该值。 */
const PROCESS_LOCK_FAILED = 'management-auth-rotation-process-lock-failed';

/**
 * 管理认证轮换跨进程锁固定错误：name/code/message 三码固定。
 * 构造参数一律忽略：任何未知输入（路径、底层错误、token 等）都不会被回显。
 */
export class ManagementAuthRotationProcessLockError extends Error {
  constructor() {
    super(PROCESS_LOCK_FAILED);
    this.name = 'ManagementAuthRotationProcessLockError';
    this.code = PROCESS_LOCK_FAILED;
  }
}

/**
 * 获取跨进程排他锁 —— bootstrap 骨架：调用即固定抛 ManagementAuthRotationProcessLockError。
 * 零 fs/spawn/lockf/目录写；参数一律忽略且绝不回显。
 */
export function acquireManagementAuthRotationProcessLock() {
  throw new ManagementAuthRotationProcessLockError();
}

/**
 * 释放跨进程排他锁 —— bootstrap 骨架：调用即固定抛 ManagementAuthRotationProcessLockError。
 * 零 fs/spawn/lockf/目录写；参数一律忽略且绝不回显。
 */
export function releaseManagementAuthRotationProcessLock() {
  throw new ManagementAuthRotationProcessLockError();
}

/**
 * 构造排他锁执行器 —— bootstrap 骨架：构造本身零 I/O、零副作用。
 * 返回 async withExclusiveLock(task)；调用该函数即固定抛
 * ManagementAuthRotationProcessLockError，且绝不调用 task。
 * @returns {(task: unknown) => Promise<never>}
 */
export function createManagementAuthRotationExclusiveLock() {
  return async function withExclusiveLock() {
    throw new ManagementAuthRotationProcessLockError();
  };
}

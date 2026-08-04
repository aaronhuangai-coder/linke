/**
 * V1.46 管理认证轮换 CLI 命令 —— bootstrap 骨架。
 *
 * 本轮只交付可导入的固定契约面，不交付任何真实命令能力：
 * - 固定错误类型 ManagementAuthRotateCommandError（message/code 固定，
 *   绝不回显 argv、stdin、token、路径或底层错误）；
 * - runManagementAuthRotateCommand 调用即固定失败：不读取 rawArgv 内容、
 *   不触碰 deps.input、不构造 KeychainStore、不调用锁/stage、不写 stdout/stderr。
 */

/** 命令固定错误码：message 与 code 恒等于该值。 */
const ROTATE_COMMAND_FAILED = 'management-auth-rotate-failed';

/**
 * 管理认证轮换命令固定错误：name/code/message 三码固定。
 * 构造参数一律忽略：任何未知输入都不会被回显。
 */
export class ManagementAuthRotateCommandError extends Error {
  constructor() {
    super(ROTATE_COMMAND_FAILED);
    this.name = 'ManagementAuthRotateCommandError';
    this.code = ROTATE_COMMAND_FAILED;
  }
}

/**
 * management-auth-rotate 命令入口 —— bootstrap 骨架：调用即固定抛
 * ManagementAuthRotateCommandError。不读取 rawArgv 内容、不触碰 deps.input、
 * 不构造 KeychainStore、不调用锁/stage、不写 stdout/stderr。
 * @param {unknown} rawArgv 原样透传的 argv（本轮绝不读取其内容）
 * @param {unknown} deps 预留依赖注入位（本轮绝不读取）
 * @returns {Promise<never>}
 */
export async function runManagementAuthRotateCommand(rawArgv, deps) {
  throw new ManagementAuthRotateCommandError();
}

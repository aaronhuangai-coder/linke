/**
 * V1.46 管理认证 Keychain 轮换 staging 公共合约骨架。
 *
 * 当前 bootstrap 仅提供稳定导出与固定、无敏感信息的错误形状；行为实现将在
 * 后续 TDD 切片中交付。此模块不含默认锁，也不会在 skeleton 阶段触碰 Keychain。
 */

const ROTATION_INVALID = 'management-auth-rotation-invalid';
const ROTATION_UNAVAILABLE = 'management-auth-rotation-unavailable';
const ROTATION_RECOVERY_REQUIRED = 'management-auth-rotation-recovery-required';

const ROTATION_ERROR_CODES = new Set([
  ROTATION_INVALID,
  ROTATION_UNAVAILABLE,
  ROTATION_RECOVERY_REQUIRED,
]);

/**
 * 管理认证轮换固定错误：name/code/message 不包含 token、itemId、scope、路径或底层错误。
 */
export class ManagementAuthRotationError extends Error {
  /**
   * @param {unknown} code
   */
  constructor(code = ROTATION_INVALID) {
    const fixedCode = ROTATION_ERROR_CODES.has(code) ? code : ROTATION_INVALID;
    super(fixedCode);
    this.name = 'ManagementAuthRotationError';
    this.code = fixedCode;
  }
}

/**
 * 管理认证 Keychain 轮换 staging 入口。
 *
 * Skeleton 只建立可导入公共合约；在行为实现落地前固定 fail closed，且不读取参数、
 * 不调用 lock、不访问 Keychain。
 * @param {unknown} _input
 * @returns {Promise<never>}
 */
export async function stageManagementAuthKeychainRotation(_input) {
  throw new ManagementAuthRotationError(ROTATION_INVALID);
}

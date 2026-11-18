import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';
import { query } from './db.js';
import { enrollmentPublicConfig } from './enrollment-contract.js';
import { terminateSessionsForNode } from './bastion/registry.js';
import { invalidateTicketsForNode } from './bastion/tickets.js';

export class OffboardingError extends Error {
  constructor(public readonly status: number, public readonly code: string, message?: string) {
    super(message || code);
  }
}

export interface PendingOffboardingRow {
  operation_id: string;
  node_id: string;
  invitation_id: string;
  node_name: string;
  node_ip: string;
  wireguard_public_key: string;
  state: string;
  created_at: Date | string;
}

export function safeDirectory(directory: string, writable: boolean): void {
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== path.resolve(directory)) {
    throw new Error('Invalid directory');
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o022) !== 0) throw new Error('Unsafe directory');
  if (writable && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
    throw new Error('Unsafe request directory');
  }
  if (!writable && config.NODE_ENV !== 'test' && stat.uid !== 0) {
    throw new Error('Unsafe acknowledgement owner');
  }
}

export function readRemovalFile(filename: string, acknowledgement: boolean): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 512 || (stat.mode & 0o022)
      || (acknowledgement && config.NODE_ENV !== 'test' && stat.uid !== 0)) {
      throw new Error('Invalid removal file');
    }
    return fs.readFileSync(fd, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export const HELPER_ERROR_WHITELIST = new Set([
  'REMOVE_ACK_CONFLICT',
  'PEER_REMOVE_FAILED',
  'PEER_SHOW_FAILED',
  'PEER_REMOVE_VERIFY_FAILED',
  'ACK_WRITE_FAILED',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WG_KEY_REGEX = /^[A-Za-z0-9+/]{43}=$/;
const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

export function validateRemovalIdentity(
  operationId: string,
  nodeId: string,
  invitationId: string,
  publicKey: string,
  nodeIp: string
): void {
  if (!UUID_REGEX.test(operationId) || !UUID_REGEX.test(nodeId) || !UUID_REGEX.test(invitationId)) {
    throw new OffboardingError(400, 'OFFBOARD_BAD_INPUT', 'Định dạng UUID không hợp lệ.');
  }
  if (!WG_KEY_REGEX.test(publicKey)) {
    throw new OffboardingError(400, 'OFFBOARD_BAD_INPUT', 'Khóa công khai WireGuard không hợp lệ.');
  }
  if (!IPV4_REGEX.test(nodeIp)) {
    throw new OffboardingError(400, 'OFFBOARD_BAD_INPUT', 'Địa chỉ IP máy chủ không hợp lệ.');
  }
}

export function buildRemovalPayload(
  operationId: string,
  nodeId: string,
  invitationId: string,
  publicKey: string,
  nodeIp: string,
): string {
  validateRemovalIdentity(operationId, nodeId, invitationId, publicKey, nodeIp);
  return `1\n${operationId}\n${nodeId}\n${invitationId}\n${publicKey}\n${nodeIp}\n`;
}

export function publishWorkerPeerRemoval(
  operationId: string,
  nodeId: string,
  invitationId: string,
  publicKey: string,
  nodeIp: string,
): boolean {
  validateRemovalIdentity(operationId, nodeId, invitationId, publicKey, nodeIp);
  safeDirectory(config.ENROLLMENT_REQUEST_DIR, true);
  safeDirectory(config.ENROLLMENT_ACK_DIR, false);

  const content = buildRemovalPayload(operationId, nodeId, invitationId, publicKey, nodeIp);
  const target = path.join(config.ENROLLMENT_REQUEST_DIR, `${operationId}.remove`);
  const current = readRemovalFile(target, false);

  if (current !== null && current !== content) {
    throw new Error('Removal request conflicts with existing payload');
  }

  if (current === null) {
    const temporary = path.join(
      config.ENROLLMENT_REQUEST_DIR,
      `.${operationId}.${crypto.randomBytes(8).toString('hex')}.tmp`
    );
    let fd: number | undefined;
    let dirFd: number | undefined;
    try {
      fd = fs.openSync(
        temporary,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
        0o600
      );
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      fs.renameSync(temporary, target);

      dirFd = fs.openSync(config.ENROLLMENT_REQUEST_DIR, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
      dirFd = undefined;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      if (dirFd !== undefined) {
        try { fs.closeSync(dirFd); } catch { /* ignore */ }
      }
      try { fs.unlinkSync(temporary); } catch { /* Already renamed or never created */ }
    }
  }

  const errorFile = path.join(config.ENROLLMENT_ACK_DIR, `${operationId}.remove-error`);
  const rawError = readRemovalFile(errorFile, true);
  if (rawError !== null) {
    const trimmed = rawError.trim();
    const safeCode = HELPER_ERROR_WHITELIST.has(trimmed) ? trimmed : 'PEER_REMOVE_FAILED';
    throw new OffboardingError(409, safeCode, `Helper báo cáo lỗi thu hồi: ${safeCode}`);
  }

  const ackFile = path.join(config.ENROLLMENT_ACK_DIR, `${operationId}.removed`);
  const ack = readRemovalFile(ackFile, true);
  if (ack !== null && ack !== content) {
    throw new OffboardingError(409, 'ACK_PAYLOAD_MISMATCH', 'Nội dung xác nhận thu hồi không khớp.');
  }
  return ack === content;
}

let isReconciling = false;

export async function reconcilePendingOffboardings(): Promise<void> {
  if (isReconciling) return;
  if (!config.ENROLLMENT_ENABLED) return;

  isReconciling = true;
  try {
    let gatewayId: string;
    try {
      gatewayId = enrollmentPublicConfig(config).gateway_id;
    } catch {
      return;
    }

    const pendingRes = await query<PendingOffboardingRow>(
      'SELECT * FROM public.list_pending_worker_offboardings($1)',
      [gatewayId]
    );

    for (const row of pendingRes.rows) {
      try {
        const peerReady = publishWorkerPeerRemoval(
          row.operation_id,
          row.node_id,
          row.invitation_id,
          row.wireguard_public_key,
          row.node_ip
        );

        if (peerReady) {
          await query(
            'SELECT * FROM public.ack_worker_peer_removal($1, $2, $3, $4, $5::inet)',
            [row.operation_id, row.node_id, gatewayId, row.wireguard_public_key, row.node_ip]
          );

          // Xóa tệp yêu cầu .peer cũ khỏi thư mục requests của Gateway sau khi đã có ACK từ helper và CSDL
          const peerRequest = path.join(config.ENROLLMENT_REQUEST_DIR, `${row.invitation_id}.peer`);
          try {
            fs.unlinkSync(peerRequest);
          } catch (unlinkErr: any) {
            if (unlinkErr.code !== 'ENOENT') {
              console.warn('⚠️ [OFFBOARDING] Không thể xóa tệp .peer cũ:', unlinkErr.code || unlinkErr.name);
            }
          }
        }
      } catch (err: any) {
        const errorCode = (err instanceof OffboardingError && (HELPER_ERROR_WHITELIST.has(err.code) || err.code === 'ACK_PAYLOAD_MISMATCH'))
          ? err.code
          : 'PEER_REMOVE_FAILED';
        try {
          await query(
            'SELECT public.record_worker_offboarding_error($1, $2, $3)',
            [row.operation_id, gatewayId, errorCode]
          );
        } catch {
          // Bỏ qua lỗi ghi nhận để không làm hỏng chu kỳ quét
        }
        console.warn(`⚠️ [OFFBOARDING] Lỗi đối soát offboarding ${row.operation_id} [${errorCode}]`);
      }
    }
  } catch (err: any) {
    console.warn('⚠️ [OFFBOARDING RECONCILE ERROR]:', err.message);
  } finally {
    isReconciling = false;
  }
}

export function revokeNodeAccess(nodeId: string): void {
  try {
    terminateSessionsForNode(nodeId);
    invalidateTicketsForNode(nodeId);
  } catch (err: any) {
    console.warn(`⚠️ [OFFBOARDING] Lỗi thu hồi phiên/vé SSH cho node ${nodeId}:`, err.message);
  }
}

export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function mapSqlOffboardError(error: unknown): OffboardingError {
  if (error instanceof OffboardingError) return error;
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('OFFBOARD_BAD_INPUT')) {
    return new OffboardingError(400, 'OFFBOARD_BAD_INPUT', 'Dữ liệu đầu vào thu hồi không hợp lệ.');
  }
  if (message.includes('OFFBOARD_STEPS_INCOMPLETE')) {
    return new OffboardingError(400, 'OFFBOARD_STEPS_INCOMPLETE', 'Tất cả 5 bước dọn dẹp bắt buộc phải ở trạng thái DONE.');
  }
  if (message.includes('OFFBOARD_NAME_MISMATCH')) {
    return new OffboardingError(400, 'OFFBOARD_NAME_MISMATCH', 'Tên xác nhận máy chủ không khớp.');
  }
  if (message.includes('OFFBOARD_UNAUTHORIZED')) {
    return new OffboardingError(403, 'OFFBOARD_UNAUTHORIZED', 'Tài khoản không đủ quyền hạn thực hiện thao tác.');
  }
  if (message.includes('OFFBOARD_CAPABILITY_INVALID')) {
    return new OffboardingError(401, 'OFFBOARD_CAPABILITY_INVALID', 'Mã xác thực dọn dẹp hoặc định danh không hợp lệ.');
  }
  if (message.includes('OFFBOARD_NODE_NOT_FOUND')) {
    return new OffboardingError(404, 'OFFBOARD_NODE_NOT_FOUND', 'Không tìm thấy máy chủ con tương ứng.');
  }
  if (message.includes('OFFBOARD_OPERATION_NOT_FOUND')) {
    return new OffboardingError(404, 'OFFBOARD_OPERATION_NOT_FOUND', 'Không tìm thấy quy trình offboarding tương ứng.');
  }
  if (message.includes('OFFBOARD_IDENTITY_UNAVAILABLE')) {
    return new OffboardingError(409, 'OFFBOARD_IDENTITY_UNAVAILABLE', 'Máy chủ legacy không có thông tin định danh WireGuard hợp lệ.');
  }
  if (message.includes('OFFBOARD_GATEWAY_MISMATCH')) {
    return new OffboardingError(409, 'OFFBOARD_GATEWAY_MISMATCH', 'Gateway ID không trùng khớp với đăng ký máy chủ.');
  }
  if (message.includes('OFFBOARD_TUPLE_MISMATCH')) {
    return new OffboardingError(409, 'OFFBOARD_TUPLE_MISMATCH', 'Thông tin định danh không khớp với bản ghi offboarding.');
  }
  if (message.includes('OFFBOARD_PEER_NOT_REVOKED')) {
    return new OffboardingError(409, 'OFFBOARD_PEER_NOT_REVOKED', 'WireGuard peer chưa được thu hồi an toàn.');
  }
  if (message.includes('OFFBOARD_RECEIPT_CONFLICT')) {
    return new OffboardingError(409, 'OFFBOARD_RECEIPT_CONFLICT', 'Biên bản dọn dẹp xung đột với bản ghi đã hoàn tất trước đó.');
  }
  if (message.includes('OFFBOARD_RECEIPT_IDENTITY_MISMATCH')) {
    return new OffboardingError(409, 'OFFBOARD_RECEIPT_IDENTITY_MISMATCH', 'Định danh trong biên bản không khớp với bản ghi offboarding.');
  }
  if (message.includes('OFFBOARD_ALREADY_COMPLETED')) {
    return new OffboardingError(409, 'OFFBOARD_ALREADY_COMPLETED', 'Quy trình offboarding đã hoàn tất trước đó.');
  }
  if (message.includes('OFFBOARD_INVALID_LIFECYCLE')) {
    return new OffboardingError(409, 'OFFBOARD_INVALID_LIFECYCLE', 'Trạng thái vòng đời máy chủ không cho phép thực hiện thao tác.');
  }

  return new OffboardingError(503, 'OFFBOARD_UNAVAILABLE', 'Dịch vụ offboarding tạm thời không khả dụng.');
}

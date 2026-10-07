import crypto from 'node:crypto';

/**
 * ==============================================================================
 * BỘ TIỆN ÍCH MẬT MÃ AN TOÀN (crypto.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: security (chủ trì), backend
 * ==============================================================================
 *
 * LÝ DO PHI TRỰC GIÁC (RATIONALE):
 * 1. Tuyệt đối không dùng toán tử so sánh chuỗi trần '===' đối với chuỗi băm xác thực
 *    hoặc chữ ký số để ngăn chặn triệt để tấn công kênh kề phân tích thời gian (Timing Attack).
 * 2. Mật khẩu được băm qua Scrypt (NIST SP 800-132) với muối ngẫu nhiên (salt),
 *    sử dụng 100% thư viện chuẩn node:crypto mà không cần cài thêm binary native bên ngoài.
 */

/**
 * Băm mật khẩu người dùng với Scrypt và muối ngẫu nhiên 16 bytes
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Kiểm tra mật khẩu khớp với chuỗi băm đã lưu (sử dụng timingSafeEqual)
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  try {
    const parts = storedHash.split(':');
    if (parts.length !== 2) return false;
    const [salt, expectedHex] = parts;
    const expectedBuffer = Buffer.from(expectedHex, 'hex');
    const derivedBuffer = crypto.scryptSync(password, salt, 64);

    if (expectedBuffer.length !== derivedBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, derivedBuffer);
  } catch {
    return false;
  }
}

/**
 * Băm token định danh của Agent bằng SHA-256 thành chuỗi hex 64 ký tự
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * So sánh an toàn bất biến thời gian giữa hai chuỗi hex
 * CHÚ THÍCH BẢO MẬT: Bắt buộc chuẩn hóa thành Buffer cùng độ dài trước khi gọi crypto.timingSafeEqual
 */
export function timingSafeCompare(knownHex: string, candidateHex: string): boolean {
  try {
    const bufA = Buffer.from(knownHex, 'utf8');
    const bufB = Buffer.from(candidateHex, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Sinh chuỗi hex ngẫu nhiên an toàn dùng cho One-Time Ticket hoặc OTP
 */
export function generateSecureToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Sinh mã OTP chữ số ngẫu nhiên cho Telegram Pairing
 */
export function generateNumericOtp(length: number = 6): string {
  const max = Math.pow(10, length);
  const randomNum = crypto.randomInt(0, max);
  return randomNum.toString().padStart(length, '0');
}

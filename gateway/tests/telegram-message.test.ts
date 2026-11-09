/** Pure formatting checks; no Telegram requests or database connection. */
import { describe, expect, it } from 'vitest';
import { formatTelegramAlert, formatTelegramRecovery } from '../src/services/telegram-message.js';

const time = new Date('2026-10-20T18:05:06Z');

describe('Telegram recovery text', () => {
  it('reports Online from an authenticated heartbeat without claiming a physical reboot', () => {
    const text = formatTelegramRecovery('worker*literal', '10.100.0.2', 57, time);
    expect(text).toContain('ZT-ServerOps | Online trở lại');
    expect(text).toContain('Mức độ: Thông tin\nMáy chủ: worker*literal');
    expect(text).toContain('IP WireGuard: 10.100.0.2');
    expect(text).toContain('Khoảng thời gian không nhận heartbeat: 57 giây');
    expect(text).not.toMatch(/đã bật|khởi động lại|đã tắt/);
  });
  it('shows the actual recovery time in Vietnam with date rollover', () => {
    expect(formatTelegramRecovery('worker-test', '10.100.0.2', 0, time))
      .toMatch(/Thời điểm phục hồi: .*01:05:06.*21\/10\/2026.*\(UTC\+7\)/);
  });
  it.each([[0, '0 giây'], [61, '1 phút 1 giây'], [3600, '1 giờ'], [3661, '1 giờ 1 phút 1 giây']])(
    'formats a heartbeat gap of %s seconds as %s', (seconds, label) => {
      expect(formatTelegramRecovery('worker-test', '10.100.0.2', seconds, time))
        .toContain(`Khoảng thời gian không nhận heartbeat: ${label}`);
    });
  it.each([null, NaN, Infinity, -1])('does not invent a duration from %s', seconds => {
    expect(formatTelegramRecovery('worker-test', '10.100.0.2', seconds, time))
      .toContain('Khoảng thời gian không nhận heartbeat: Chưa xác định');
  });
});

describe('Telegram alert text', () => {
  it('shows actual CPU, threshold and an action without repeating the internal event code', () => {
    const text = formatTelegramAlert('node-windows-01', 'WARNING',
      'CPU_HIGH: node-windows-01 CPU 93.75% >= 85%.', time);
    expect(text).toContain('ZT-ServerOps | CPU cao');
    expect(text).toContain('Mức độ: Cảnh báo\nMáy chủ: node-windows-01');
    expect(text).toContain('CPU ghi nhận: 93.75%\nNgưỡng cảnh báo: ≥ 85%');
    expect(text).toContain('Kiểm tra tiến trình sử dụng CPU');
    expect(text).not.toContain('CPU_HIGH:');
  });

  it('describes lost heartbeats without claiming the machine is powered off', () => {
    const text = formatTelegramAlert('node-linux-01', 'CRITICAL',
      'NODE_OFFLINE: Máy chủ con node-linux-01 (10.100.0.4) không phản hồi quá 30s.', time);
    expect(text).toContain('ZT-ServerOps | Mất kết nối máy chủ');
    expect(text).toContain('Mức độ: Nghiêm trọng');
    expect(text).toContain('IP WireGuard: 10.100.0.4\nKhông nhận heartbeat quá: 30 giây');
    expect(text).toContain('Agent và kết nối WireGuard');
    expect(text).not.toContain('NODE_OFFLINE:');
    expect(text).not.toContain('đã tắt');
  });

  it('uses explicit Vietnam time with the correct date rollover', () => {
    const text = formatTelegramAlert('test-node', 'INFO', '[GIẢ LẬP] Kiểm tra nội dung', time);
    expect(text).toMatch(/Thời điểm thông báo: .*01:05:06.*21\/10\/2026.*\(UTC\+7\)/);
    expect(text).toContain('Mức độ: Thông tin');
  });

  it.each([
    '[GIẢ LẬP] CPU_HIGH: node-windows-01 CPU 99% >= 85%.',
    'CPU_HIGH: node-other CPU 99% >= 85%.',
    'CPU_HIGH: node-windows-01 CPU 999% >= 85%.',
    'CPU_HIGH: node-windows-01 CPU 10% >= 85%.',
    'NODE_OFFLINE: Máy chủ con node-other (10.100.0.4) không phản hồi quá 30s.',
    'NODE_OFFLINE: Máy chủ con node-windows-01 (10.100.0.3) không phản hồi quá 0s.',
    'Thông báo riêng *không phải Markdown* <test> & [GIẢ LẬP]',
  ])('preserves custom or unrecognized messages: %s', (message) => {
    const text = formatTelegramAlert('node-windows-01', 'WARNING', message, time);
    expect(text).toContain('ZT-ServerOps | Thông báo hệ thống');
    expect(text.split('\n')).toContain(message);
  });
});

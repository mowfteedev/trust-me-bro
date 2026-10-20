type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

const severityLabels: Record<Severity, string> = {
  INFO: 'Thông tin', WARNING: 'Cảnh báo', CRITICAL: 'Nghiêm trọng',
};
const vietnamTime = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function formatTelegramAlert(nodeName: string, severity: Severity, message: string, now = new Date()): string {
  let title = 'Thông báo hệ thống';
  let details = [message];
  const cpu = /^CPU_HIGH: (.+) CPU (\d+(?:\.\d+)?)% >= (\d+(?:\.\d+)?)%\.$/.exec(message);
  const offline = /^NODE_OFFLINE: Máy chủ con (.+) \(([^()\r\n]+)\) không phản hồi quá (\d+)s\.$/.exec(message);

  // Only translate known event payloads; preserve custom messages and test labels verbatim.
  if (cpu?.[1] === nodeName && Number(cpu[2]) <= 100 && Number(cpu[3]) <= 100 && Number(cpu[2]) >= Number(cpu[3])) {
    title = 'CPU cao';
    details = [
      `CPU ghi nhận: ${cpu[2]}%`, `Ngưỡng cảnh báo: ≥ ${cpu[3]}%`,
      'Đề nghị: Kiểm tra tiến trình sử dụng CPU qua Web SSH.',
    ];
  } else if (offline?.[1] === nodeName && Number.isSafeInteger(Number(offline[3])) && Number(offline[3]) > 0) {
    title = 'Mất kết nối máy chủ';
    details = [
      `IP WireGuard: ${offline[2]}`, `Không nhận heartbeat quá: ${offline[3]} giây`,
      'Đề nghị: Kiểm tra trạng thái máy chủ, Agent và kết nối WireGuard.',
    ];
  }

  return [
    `ZT-ServerOps | ${title}`, `Mức độ: ${severityLabels[severity]}`, `Máy chủ: ${nodeName}`,
    ...details, `Thời điểm thông báo: ${vietnamTime.format(now)} (UTC+7)`,
  ].join('\n');
}

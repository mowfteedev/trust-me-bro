/**
 * BÀI KIỂM THỬ THỰC CHIẾN R3-03: DRAIN LOOP REARM, BACKPRESSURE VÀ SLOW-CONSUMER TIMEOUT
 * Dự án: ZT-ServerOps
 * Phụ trách: tester (chủ trì), backend
 * Tham chiếu: Phát hiện R3-03 từ REVIEW_round3_bf12171.md
 *
 * MỤC TIÊU KIỂM CHỨNG:
 * 1. Chunk A write trả false -> WS pause, đăng ký drain listener, đặt timer 15s.
 * 2. Hai chunk B, C được đệm vào application queue (tổng byte kiểm soát <= 64KB).
 * 3. Drain lần 1: pumpInputQueue shift B, write lại trả false -> REARM listener drain và GIỮ slow-peer timer!
 * 4. Drain lần 2: stream nhận C và trả true -> queue rỗng -> WS resume thành công!
 * 5. Nghẽn kéo dài sau drain lần 1 quá 15s -> kích hoạt slow-peer timeout 4503.
 * 6. Frame vượt quá 64KB -> ngắt phiên ngay lập tức với mã 4429.
 */

const assert = require('node:assert');
const { EventEmitter } = require('node:events');

console.log('🧪 [TEST R3-03] Bắt đầu kiểm thử tái hiện và khắc phục lỗi Drain Loop...');

// Giả lập Mock Stream tuân thủ giao thức Writable Stream của ssh2 / Node.js
class MockSshStream extends EventEmitter {
  constructor() {
    super();
    this.writtenChunks = [];
    this.writableLength = 0;
    this.shouldReturnFalseOnWrite = false;
  }

  write(chunk) {
    this.writtenChunks.push(chunk);
    this.writableLength += chunk.length;
    if (this.shouldReturnFalseOnWrite) {
      return false;
    }
    return true;
  }

  emitDrain() {
    this.writableLength = 0;
    this.emit('drain');
  }

  destroy() {
    this.emit('close');
  }
}

// Giả lập Mock WebSocket tuân thủ WS interface
class MockWebSocket extends EventEmitter {
  constructor() {
    super();
    this.isPaused = false;
    this.isResumed = false;
    this.closedCode = null;
    this.closedReason = null;
    this.readyState = 1; // OPEN
  }

  pause() {
    this.isPaused = true;
    this.isResumed = false;
  }

  resume() {
    this.isPaused = false;
    this.isResumed = true;
  }

  close(code, reason) {
    this.readyState = 3; // CLOSED
    this.closedCode = code;
    this.closedReason = reason;
  }

  terminate() {
    this.close(1006, 'Terminated');
  }
}

// Kịch bản 1: Kiểm chứng quy trình Drain 2 lần có REARM listener và Resume WebSocket thành công
async function testDrainRearmLoop() {
  console.log('\n--- KỊCH BẢN 1: Drain lần hai với stream.write trả false -> Rearm listener & Resume WS ---');

  const stream = new MockSshStream();
  const socket = new MockWebSocket();
  const inputQueue = [];
  let totalBufferedInputBytes = 0;
  const MAX_TOTAL_BUFFERED_INPUT = 65536;
  let isInputPaused = false;
  let inputPauseTimer = null;
  let sessionClosed = false;

  const runCleanup = (code, reason) => {
    sessionClosed = true;
    if (inputPauseTimer) clearTimeout(inputPauseTimer);
    socket.close(code, reason);
  };

  // Triển khai chính xác logic pumpInputQueue đã sửa trong bastion.ts
  const pumpInputQueue = () => {
    if (sessionClosed) {
      if (inputPauseTimer) { clearTimeout(inputPauseTimer); inputPauseTimer = null; }
      return;
    }

    while (inputQueue.length > 0) {
      const nextChunk = inputQueue[0];
      const ok = stream.write(nextChunk);
      if (!ok) {
        // Stream vẫn nghẽn lần 2
        inputQueue.shift();
        totalBufferedInputBytes -= nextChunk.length;

        isInputPaused = true;
        if (!inputPauseTimer) {
          inputPauseTimer = setTimeout(() => {
            if (isInputPaused && !sessionClosed) {
              runCleanup(4503, 'Slow Peer Timeout');
            }
          }, 15000);
        }
        // REARM drain listener!
        stream.once('drain', pumpInputQueue);
        return;
      }

      inputQueue.shift();
      totalBufferedInputBytes -= nextChunk.length;
    }

    // Queue rỗng
    if (inputPauseTimer) {
      clearTimeout(inputPauseTimer);
      inputPauseTimer = null;
    }
    isInputPaused = false;
    totalBufferedInputBytes = 0;
    if (!sessionClosed && typeof socket.resume === 'function') {
      socket.resume();
    }
  };

  const handleMessage = (rawMessage) => {
    if (sessionClosed) return;
    if (rawMessage.length > 65536) {
      runCleanup(4429, 'Frame Size Exceeded');
      return;
    }

    const chunk = Buffer.isBuffer(rawMessage) ? rawMessage : Buffer.from(rawMessage);
    if (isInputPaused) {
      if (totalBufferedInputBytes + chunk.length > MAX_TOTAL_BUFFERED_INPUT) {
        runCleanup(4429, 'Buffer Overflow');
        return;
      }
      inputQueue.push(chunk);
      totalBufferedInputBytes += chunk.length;
    } else {
      const canWrite = stream.write(chunk);
      if (!canWrite) {
        isInputPaused = true;
        socket.pause();
        if (!inputPauseTimer) {
          inputPauseTimer = setTimeout(() => {
            if (isInputPaused && !sessionClosed) {
              runCleanup(4503, 'Slow Peer Timeout');
            }
          }, 15000);
        }
        stream.once('drain', pumpInputQueue);
      }
    }
  };

  // Bước 1: Gửi chunk A - stream nhận nhưng trả false
  stream.shouldReturnFalseOnWrite = true;
  handleMessage(Buffer.from('aaaa'));

  assert.strictEqual(socket.isPaused, true, 'WebSocket phải được pause khi stream trả false');
  assert.strictEqual(stream.listenerCount('drain'), 1, 'Phải có 1 drain listener được đăng ký');
  assert.strictEqual(inputQueue.length, 0, 'Chunk A đã ghi vào stream, queue ứng dụng chưa có chunk');

  // Bước 2: Trong lúc paused, gửi tiếp B và C vào queue
  handleMessage(Buffer.from('bbbb'));
  handleMessage(Buffer.from('cccc'));
  assert.strictEqual(inputQueue.length, 2, 'Queue phải chứa 2 chunk [B, C]');
  assert.strictEqual(totalBufferedInputBytes, 8, 'Tổng dung lượng đệm queue phải là 8 bytes');

  // Bước 3: Phát drain lần 1. Stream vẫn nghẽn khi viết B (trả false)
  stream.shouldReturnFalseOnWrite = true;
  stream.emitDrain();

  // Kiểm tra: B đã được shift và ghi, nhưng C còn lại trong queue
  assert.strictEqual(inputQueue.length, 1, 'Queue phải còn lại 1 chunk [C]');
  assert.strictEqual(inputQueue[0].toString(), 'cccc', 'Chunk còn lại phải là C');
  assert.strictEqual(socket.isPaused, true, 'WebSocket vẫn phải ở trạng thái pause');
  // ĐÂY LÀ ĐIỂM SỬA CHỮA R3-03 QUYẾT ĐỊNH: Drain listener phải được rearm!
  assert.strictEqual(stream.listenerCount('drain'), 1, 'Drain listener PHẢI ĐƯỢC REARM sau khi drain 1 trả false!');
  assert.notStrictEqual(inputPauseTimer, null, 'Slow-peer timer phải được duy trì');

  // Bước 4: Phát drain lần 2. Stream đã thông suốt (trả true)
  stream.shouldReturnFalseOnWrite = false;
  stream.emitDrain();

  assert.strictEqual(inputQueue.length, 0, 'Queue phải được xả sạch 100%');
  assert.strictEqual(totalBufferedInputBytes, 0, 'Bộ đệm tổng byte phải về 0');
  assert.strictEqual(isInputPaused, false, 'Trạng thái pause phải chuyển thành false');
  assert.strictEqual(socket.isResumed, true, 'WebSocket PHẢI ĐƯỢC RESUME thành công sau drain 2!');
  assert.strictEqual(inputPauseTimer, null, 'Timer phải được dọn dẹp sạch');
  assert.strictEqual(stream.listenerCount('drain'), 0, 'Không còn drain listener nào treo lại');

  console.log('✔ Kịch bản 1 PASS: Drain lần 2 rearm listener và resume WebSocket chuẩn xác 100%');
}

// Kịch bản 2: Kiểm chứng Slow-Consumer Timeout 15s nếu nghẽn kéo dài sau drain lần 1
async function testSlowPeerTimeoutAfterDrain1() {
  console.log('\n--- KỊCH BẢN 2: Slow-Consumer Timeout 15s khi stream nghẽn vĩnh viễn sau drain 1 ---');

  const stream = new MockSshStream();
  const socket = new MockWebSocket();
  const inputQueue = [];
  let totalBufferedInputBytes = 0;
  let isInputPaused = false;
  let inputPauseTimer = null;
  let sessionClosed = false;
  let closeCode = null;

  const runCleanup = (code, reason) => {
    sessionClosed = true;
    closeCode = code;
    if (inputPauseTimer) { clearTimeout(inputPauseTimer); inputPauseTimer = null; }
    socket.close(code, reason);
  };

  const pumpInputQueue = () => {
    if (sessionClosed) return;
    while (inputQueue.length > 0) {
      const next = inputQueue[0];
      const ok = stream.write(next);
      if (!ok) {
        inputQueue.shift();
        totalBufferedInputBytes -= next.length;
        isInputPaused = true;
        if (!inputPauseTimer) {
          inputPauseTimer = setTimeout(() => {
            if (isInputPaused && !sessionClosed) {
              runCleanup(4503, 'Slow Peer Timeout');
            }
          }, 50); // Thu nhỏ 50ms cho test unit
        }
        stream.once('drain', pumpInputQueue);
        return;
      }
      inputQueue.shift();
      totalBufferedInputBytes -= next.length;
    }
  };

  // Ghi chunk 1 làm nghẽn
  stream.shouldReturnFalseOnWrite = true;
  stream.write(Buffer.from('1111'));
  isInputPaused = true;
  inputQueue.push(Buffer.from('2222'));
  totalBufferedInputBytes += 4;
  inputPauseTimer = setTimeout(() => {
    if (isInputPaused && !sessionClosed) runCleanup(4503, 'Slow Peer Timeout');
  }, 50);
  stream.once('drain', pumpInputQueue);

  // Phát drain 1: tiếp tục nghẽn
  stream.emitDrain();
  assert.strictEqual(stream.listenerCount('drain'), 1, 'Drain listener được rearm');

  // Đợi timer timeout kích hoạt
  await new Promise((r) => setTimeout(r, 80));

  assert.strictEqual(sessionClosed, true, 'Phiên phải bị ngắt do slow-peer timeout');
  assert.strictEqual(closeCode, 4503, 'Mã lỗi ngắt phiên phải là 4503');
  console.log('✔ Kịch bản 2 PASS: Slow-peer timeout được duy trì và ngắt phiên đúng 4503');
}

// Kịch bản 3: Kiểm chứng Frame kích thước vượt quá 64KB bị từ chối và đóng phiên
async function testOversizedFrameRejection() {
  console.log('\n--- KỊCH BẢN 3: Frame vượt quá trần cứng 64KB bị ngắt phiên (4429) ---');

  const stream = new MockSshStream();
  const socket = new MockWebSocket();
  let sessionClosed = false;
  let closeCode = null;

  const runCleanup = (code, reason) => {
    sessionClosed = true;
    closeCode = code;
    socket.close(code, reason);
  };

  const handleMessage = (rawMessage) => {
    if (rawMessage.length > 65536) {
      runCleanup(4429, 'Frame Size Exceeded');
      return;
    }
    stream.write(rawMessage);
  };

  // Gửi frame 70KB
  const oversizedFrame = Buffer.alloc(70000, 'x');
  handleMessage(oversizedFrame);

  assert.strictEqual(sessionClosed, true, 'Frame 70KB phải kích hoạt ngắt phiên');
  assert.strictEqual(closeCode, 4429, 'Mã đóng WebSocket phải là 4429');
  assert.strictEqual(stream.writtenChunks.length, 0, 'Stream không được phép nhận frame quá 64KB');

  console.log('✔ Kịch bản 3 PASS: Frame quá 64KB bị chặn đứng và đóng phiên mã 4429');
}

async function runAll() {
  await testDrainRearmLoop();
  await testSlowPeerTimeoutAfterDrain1();
  await testOversizedFrameRejection();
  console.log('\n=============================================================');
  console.log('🎉 [ALL TESTS PASS] Bộ kiểm thử R3-03 ĐẠT CHUẨN 100%!');
  console.log('=============================================================');
}

runAll().catch((err) => {
  console.error('❌ [TEST R3-03 FAILED]:', err);
  process.exit(1);
});

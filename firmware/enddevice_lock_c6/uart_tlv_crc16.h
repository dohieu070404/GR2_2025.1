#pragma once

#include <Arduino.h>

// Minimal TLV + CRC16 framed UART protocol.
// Frame format:
//   [0] 0xA5
//   [1] 0x5A
//   [2] version (1)
//   [3] msgType
//   [4] length LSB
//   [5] length MSB
//   [6..] payload TLVs (len bytes)
//   [...+0] crc LSB (CRC16-CCITT-FALSE over version..payload)
//   [...+1] crc MSB

static inline uint16_t crc16_ccitt_false(const uint8_t* data, size_t len, uint16_t crc = 0xFFFF) {
  // CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, xorout 0x0000
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (int b = 0; b < 8; b++) {
      if (crc & 0x8000) crc = (uint16_t)((crc << 1) ^ 0x1021);
      else crc = (uint16_t)(crc << 1);
    }
  }
  return crc;
}

struct UartFrame {
  uint8_t version = 1;
  uint8_t msgType = 0;
  uint16_t length = 0;
  uint8_t payload[384];
};

class UartFrameParser {
 public:
  UartFrameParser() : _len(0) {}

  bool feed(Stream& s, UartFrame& out) {
    while (s.available()) {
      int c = s.read();
      if (c < 0) break;
      if (_len >= sizeof(_buf)) {
        _len = 0;
      }
      _buf[_len++] = (uint8_t)c;

      // Try parse as many frames as possible.
      while (true) {
        if (_len < 6) break;
        // Align to preamble
        if (_buf[0] != 0xA5 || _buf[1] != 0x5A) {
          // shift until we find 0xA5 0x5A
          size_t drop = 1;
          for (size_t i = 1; i + 1 < _len; i++) {
            if (_buf[i] == 0xA5 && _buf[i + 1] == 0x5A) {
              drop = i;
              break;
            }
          }
          memmove(_buf, _buf + drop, _len - drop);
          _len -= drop;
          continue;
        }

        const uint8_t ver = _buf[2];
        const uint8_t msg = _buf[3];
        const uint16_t plen = (uint16_t)_buf[4] | ((uint16_t)_buf[5] << 8);
        const size_t total = 2 + 1 + 1 + 2 + (size_t)plen + 2;
        if (_len < total) break;

        // CRC
        const uint16_t rxCrc = (uint16_t)_buf[total - 2] | ((uint16_t)_buf[total - 1] << 8);
        const uint16_t calc = crc16_ccitt_false(_buf + 2, 1 + 1 + 2 + plen);
        if (rxCrc != calc) {
          // Bad frame: drop preamble and retry
          memmove(_buf, _buf + 2, _len - 2);
          _len -= 2;
          continue;
        }

        // Good frame
        out.version = ver;
        out.msgType = msg;
        out.length = plen;
        if (plen > sizeof(out.payload)) {
          // Too big for consumer; drop
          memmove(_buf, _buf + total, _len - total);
          _len -= total;
          break;
        }
        memcpy(out.payload, _buf + 6, plen);

        // Remove consumed bytes
        memmove(_buf, _buf + total, _len - total);
        _len -= total;
        return true;
      }
    }
    return false;
  }

 private:
  uint8_t _buf[512];
  size_t _len;
};

static inline bool uartWriteFrame(Stream& s, uint8_t msgType, const uint8_t* payload, uint16_t len) {
  if (len > 384) return false;
  uint8_t hdr[6];
  hdr[0] = 0xA5;
  hdr[1] = 0x5A;
  hdr[2] = 1; // version
  hdr[3] = msgType;
  hdr[4] = (uint8_t)(len & 0xFF);
  hdr[5] = (uint8_t)((len >> 8) & 0xFF);

  uint16_t crc = 0xFFFF;
  crc = crc16_ccitt_false(&hdr[2], 4, crc); // version..len
  if (payload && len > 0) {
    crc = crc16_ccitt_false(payload, len, crc);
  }

  s.write(hdr, sizeof(hdr));
  if (payload && len > 0) s.write(payload, len);
  uint8_t c[2] = { (uint8_t)(crc & 0xFF), (uint8_t)((crc >> 8) & 0xFF) };
  s.write(c, 2);
  return true;
}

// --- TLV helpers (tag:u8 len:u8 value...) ---
struct TlvWriter {
  uint8_t buf[256];
  size_t len = 0;

  bool addU8(uint8_t tag, uint8_t v) {
    if (len + 3 > sizeof(buf)) return false;
    buf[len++] = tag;
    buf[len++] = 1;
    buf[len++] = v;
    return true;
  }

  bool addU64(uint8_t tag, uint64_t v) {
    if (len + 2 + 8 > sizeof(buf)) return false;
    buf[len++] = tag;
    buf[len++] = 8;
    for (int i = 0; i < 8; i++) buf[len++] = (uint8_t)((v >> (8 * i)) & 0xFF);
    return true;
  }

  bool addBytes(uint8_t tag, const uint8_t* d, uint8_t n) {
    if (!d && n) return false;
    if (len + 2 + n > sizeof(buf)) return false;
    buf[len++] = tag;
    buf[len++] = n;
    for (uint8_t i = 0; i < n; i++) buf[len++] = d[i];
    return true;
  }

  bool addStr(uint8_t tag, const String& s) {
    String t = s;
    if (t.length() > 200) t = t.substring(0, 200);
    uint8_t n = (uint8_t)t.length();
    if (len + 2 + n > sizeof(buf)) return false;
    buf[len++] = tag;
    buf[len++] = n;
    memcpy(buf + len, t.c_str(), n);
    len += n;
    return true;
  }
};

static inline bool tlvGetU8(const uint8_t* p, size_t n, uint8_t tag, uint8_t& out) {
  size_t i = 0;
  while (i + 2 <= n) {
    uint8_t t = p[i++];
    uint8_t l = p[i++];
    if (i + l > n) return false;
    if (t == tag && l == 1) {
      out = p[i];
      return true;
    }
    i += l;
  }
  return false;
}

static inline bool tlvGetU64(const uint8_t* p, size_t n, uint8_t tag, uint64_t& out) {
  size_t i = 0;
  while (i + 2 <= n) {
    uint8_t t = p[i++];
    uint8_t l = p[i++];
    if (i + l > n) return false;
    if (t == tag && l == 8) {
      uint64_t v = 0;
      for (int b = 0; b < 8; b++) v |= ((uint64_t)p[i + b]) << (8 * b);
      out = v;
      return true;
    }
    i += l;
  }
  return false;
}

static inline bool tlvGetStr(const uint8_t* p, size_t n, uint8_t tag, String& out) {
  size_t i = 0;
  while (i + 2 <= n) {
    uint8_t t = p[i++];
    uint8_t l = p[i++];
    if (i + l > n) return false;
    if (t == tag) {
      out = "";
      for (uint8_t b = 0; b < l; b++) out += (char)p[i + b];
      return true;
    }
    i += l;
  }
  return false;
}

